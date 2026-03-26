const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function makeCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function defaultConfig() {
  return {
    numRounds: 3,
    numUndercover: 1,
    numMrWhite: 0,
    wordsPerPlayer: 1,
    wordTime: 30,
    voteTime: 30,
    hiddenRole: false,
  };
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    host: room.host,
    config: room.config,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      connected: p.connected,
      eliminated: p.eliminated,
      score: p.score,
      roleRevealed: p.roleRevealed,
      wordsGiven: p.wordsGiven,
      role: (room.phase === 'end' || room.phase === 'round_recap' || p.eliminated)
        ? p.role
        : (room.config.hiddenRole ? null : p.role),
    })),
    wordPairs: room.wordPairs,
    currentRound: room.currentRound,
    totalRounds: room.config.numRounds,
    currentWordPlayer: room.currentWordPlayer,
    votes: room.votes,
    voteRevealed: room.voteRevealed,
    logs: room.logs,
    roundRecap: room.roundRecap,
    finalScores: room.finalScores,
    phase_timer: room.phase_timer,
    wordPlayerIndex: room.wordPlayerIndex,
    mrWhiteId: room.mrWhiteId,
    chosenPair: room.phase === 'end' || room.phase === 'round_recap' ? room.chosenPair : null,
    allWordsGiven: room.players.map(p => ({ id: p.id, words: p.wordsGiven })),
  };
}

function clearTimers(room) {
  if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }
}

function startTick(room, duration, onEnd) {
  clearTimers(room);
  room.phase_timer = duration;
  room._tickInterval = setInterval(() => {
    // Safety: if room was deleted or phase changed unexpectedly, stop
    if (!rooms[room.code]) { clearInterval(room._tickInterval); room._tickInterval = null; return; }
    room.phase_timer--;
    io.to(room.code).emit('timer_tick', { time: room.phase_timer });
    if (room.phase_timer <= 0) {
      clearInterval(room._tickInterval);
      room._tickInterval = null;
      onEnd();
    }
  }, 1000);
}

function assignRoles(room) {
  const n = room.players.length;
  const { numUndercover, numMrWhite } = room.config;
  const numCivilian = n - numUndercover - numMrWhite;
  let roles = [
    ...Array(numCivilian).fill('civilian'),
    ...Array(numUndercover).fill('undercover'),
    ...Array(numMrWhite).fill('mrwhite'),
  ];
  roles = shuffle(roles);
  const pair = room.wordPairs[Math.floor(Math.random() * room.wordPairs.length)];
  const flip = Math.random() < 0.5;
  room.chosenPair = flip ? { civ: pair.spy, spy: pair.civ } : { civ: pair.civ, spy: pair.spy };
  room.players = shuffle(room.players);
  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.word = roles[i] === 'civilian' ? room.chosenPair.civ : roles[i] === 'undercover' ? room.chosenPair.spy : null;
    p.eliminated = false;
    p.roleRevealed = false;
    p.wordsGiven = [];
  });
}

function sendPrivateRoles(room) {
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('your_role', {
      role: room.config.hiddenRole ? null : p.role,
      trueRole: p.role,
      word: p.word,
    });
  });
}

// Returns connected + non-eliminated players
function aliveConnected(room) {
  return room.players.filter(p => !p.eliminated && p.connected);
}
function alive(room) {
  return room.players.filter(p => !p.eliminated);
}

function startWordPhase(room) {
  room.phase = 'words';
  room.wordPlayerIndex = 0;
  room.players.forEach(p => { p.wordsGiven = []; });
  advanceWordPlayer(room);
}

function advanceWordPlayer(room) {
  // Only consider connected alive players for turn order
  const alivePlayers = alive(room);
  const totalTurns = alivePlayers.length * room.config.wordsPerPlayer;

  if (room.wordPlayerIndex >= totalTurns) {
    startVotePhase(room);
    return;
  }

  const playerIdx = room.wordPlayerIndex % alivePlayers.length;
  const currentPlayer = alivePlayers[playerIdx];

  // Skip disconnected players automatically
  if (!currentPlayer.connected) {
    room.logs.push(`${currentPlayer.name} est déconnecté, tour passé.`);
    room.wordPlayerIndex++;
    advanceWordPlayer(room);
    return;
  }

  room.currentWordPlayer = currentPlayer.id;
  io.to(room.code).emit('game_state', publicState(room));
  startTick(room, room.config.wordTime, () => {
    room.wordPlayerIndex++;
    advanceWordPlayer(room);
  });
}

function startVotePhase(room) {
  room.phase = 'vote';
  room.votes = {};
  room.voteRevealed = {};
  room.currentWordPlayer = null;
  io.to(room.code).emit('game_state', publicState(room));
  startTick(room, room.config.voteTime, () => {
    tallyVotes(room);
  });
}

// Check if all connected alive players have voted → auto-tally
function checkAllVoted(room) {
  const connectedAlive = alive(room).filter(p => p.connected);
  const voted = connectedAlive.filter(p => room.votes[p.id]);
  if (voted.length >= connectedAlive.length && connectedAlive.length > 0) {
    clearTimers(room);
    tallyVotes(room);
  }
}

function tallyVotes(room) {
  clearTimers(room);
  const alivePlayers = alive(room);
  if (alivePlayers.length === 0) { endRoundAfterVote(room); return; }

  const tally = {};
  alivePlayers.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(tid => { if (tally[tid] !== undefined) tally[tid]++; });

  // If nobody voted, pick a random alive player
  const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
  if (totalVotes === 0) {
    const randomTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    tally[randomTarget.id] = 1;
  }

  const maxVotes = Math.max(...Object.values(tally));
  const candidates = Object.entries(tally).filter(([, v]) => v === maxVotes).map(([k]) => k);
  const eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
  const target = room.players.find(p => p.id === eliminatedId);

  const undercoverIds = room.players.filter(p => p.role === 'undercover' || p.role === 'mrwhite').map(p => p.id);
  const unanimousVote = Object.values(room.votes).length > 0 && Object.values(room.votes).every(v => v === eliminatedId);

  Object.entries(room.votes).forEach(([voterId, targetId]) => {
    const voter = room.players.find(p => p.id === voterId);
    if (!voter) return;
    if (undercoverIds.includes(targetId)) {
      voter.score += 2;
      if (unanimousVote) voter.score += 1;
    }
  });

  room.players.filter(p => p.role === 'undercover' || p.role === 'mrwhite').forEach(p => {
    if (!p.eliminated && p.id !== eliminatedId) p.score += 3;
  });

  if (target) {
    target.eliminated = true;
    room.logs.push(`${target.name} est éliminé ! (${roleLabel(target.role)})`);
    target.roleRevealed = true;

    if (target.role === 'mrwhite') {
      room.mrWhiteId = target.id;
      room.phase = 'mrwhite_guess';
      clearTimers(room);
      io.to(room.code).emit('game_state', publicState(room));
      // If Mr. White is disconnected, skip guess
      const s = io.sockets.sockets.get(target.id);
      if (s) {
        s.emit('mrwhite_turn');
        // Auto-resolve after 30s if no answer
        room._mrwhiteTimeout = setTimeout(() => {
          if (room.phase === 'mrwhite_guess') {
            room.logs.push(`Mr. White n'a pas répondu à temps.`);
            endRoundAfterVote(room);
            io.to(room.code).emit('game_state', publicState(room));
          }
        }, 30000);
      } else {
        room.logs.push(`Mr. White est déconnecté, pas de devinette.`);
        endRoundAfterVote(room);
        io.to(room.code).emit('game_state', publicState(room));
      }
      return;
    }
  }

  endRoundAfterVote(room);
}

function endRoundAfterVote(room) {
  if (room._mrwhiteTimeout) { clearTimeout(room._mrwhiteTimeout); room._mrwhiteTimeout = null; }
  const alivePlayers = alive(room);
  const aliveUnder = alivePlayers.filter(p => p.role === 'undercover');
  const aliveWhite = alivePlayers.filter(p => p.role === 'mrwhite');
  const aliveCiv = alivePlayers.filter(p => p.role === 'civilian');

  let roundWinner;
  if (aliveUnder.length === 0 && aliveWhite.length === 0) {
    roundWinner = 'civilian';
    aliveCiv.forEach(p => { p.score += 1; });
  } else if (aliveUnder.length >= aliveCiv.length) {
    roundWinner = 'undercover';
    aliveUnder.forEach(p => { p.score += 2; });
  } else {
    roundWinner = 'civilian';
    aliveCiv.forEach(p => { p.score += 1; });
  }

  endRound(room, roundWinner);
}

function endRound(room, winner) {
  clearTimers(room);
  room.roundRecap = {
    winner,
    round: room.currentRound,
    players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, word: p.word, score: p.score, avatar: p.avatar })),
    chosenPair: room.chosenPair,
  };
  room.phase = 'round_recap';
  io.to(room.code).emit('game_state', publicState(room));
}

function nextRound(room) {
  if (room.currentRound >= room.config.numRounds) {
    endGame(room);
    return;
  }
  room.currentRound++;
  room.logs = [];
  assignRoles(room);
  sendPrivateRoles(room);
  startWordPhase(room);
}

function endGame(room) {
  clearTimers(room);
  room.phase = 'end';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  room.finalScores = sorted.map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, score: p.score, role: p.role }));
  io.to(room.code).emit('game_state', publicState(room));
}

// Reassign host to another connected player if current host left
function reassignHost(room) {
  const connected = room.players.filter(p => p.connected);
  if (connected.length > 0 && !connected.find(p => p.id === room.host)) {
    room.host = connected[0].id;
    room.logs.push(`${connected[0].name} est maintenant l'hôte.`);
  }
}

// Full reset of a room back to lobby, keeping connected players
function resetRoomToLobby(room) {
  clearTimers(room);
  if (room._mrwhiteTimeout) { clearTimeout(room._mrwhiteTimeout); room._mrwhiteTimeout = null; }
  room.phase = 'lobby';
  // Remove disconnected players on restart
  room.players = room.players.filter(p => p.connected);
  room.players.forEach(p => {
    p.role = null; p.word = null; p.eliminated = false;
    p.roleRevealed = false; p.wordsGiven = []; p.score = 0;
  });
  room.currentRound = 1;
  room.votes = {}; room.voteRevealed = {}; room.logs = [];
  room.roundRecap = null; room.finalScores = null;
  room.currentWordPlayer = null; room.wordPlayerIndex = 0;
  room.mrWhiteId = null; room.phase_timer = 0;
  reassignHost(room);
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, avatar }) => {
    const code = makeCode();
    rooms[code] = {
      code, phase: 'lobby', host: socket.id,
      players: [], config: defaultConfig(),
      wordPairs: [], chosenPair: null,
      currentRound: 1,
      currentWordPlayer: null, wordPlayerIndex: 0,
      votes: {}, voteRevealed: {},
      logs: [], roundRecap: null, finalScores: null,
      phase_timer: 0, mrWhiteId: null,
      _tickInterval: null, _mrwhiteTimeout: null,
    };
    socket.join(code);
    rooms[code].players.push({ id: socket.id, name, avatar, eliminated: false, connected: true, role: null, word: null, roleRevealed: false, wordsGiven: [], score: 0 });
    socket.emit('room_joined', { code, playerId: socket.id });
    io.to(code).emit('game_state', publicState(rooms[code]));
  });

  socket.on('join_room', ({ code, name, avatar }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    if (room.phase !== 'lobby') return socket.emit('error', 'La partie a déjà commencé.');
    if (room.players.length >= 20) return socket.emit('error', 'Salon plein.');
    // Prevent duplicate names
    if (room.players.find(p => p.name === name && p.connected)) return socket.emit('error', 'Ce pseudo est déjà utilisé.');
    socket.join(code);
    room.players.push({ id: socket.id, name, avatar, eliminated: false, connected: true, role: null, word: null, roleRevealed: false, wordsGiven: [], score: 0 });
    socket.emit('room_joined', { code, playerId: socket.id });
    io.to(code).emit('game_state', publicState(room));
  });

  // Rejoin mid-game (page refresh)
  socket.on('rejoin_room', ({ code, name, avatar }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
      if (avatar) existing.avatar = avatar;
      // If this player was the host, update host id
      if (room.host === existing.id || !room.players.find(p => p.id === room.host && p.connected)) {
        room.host = socket.id;
      }
    } else {
      if (room.phase !== 'lobby') return socket.emit('error', 'Partie déjà commencée.');
      room.players.push({ id: socket.id, name, avatar, eliminated: false, connected: true, role: null, word: null, roleRevealed: false, wordsGiven: [], score: 0 });
    }
    socket.join(code);
    socket.emit('room_joined', { code, playerId: socket.id });
    socket.emit('game_state', publicState(room));
    if (room.phase !== 'lobby') {
      const p = room.players.find(p => p.id === socket.id);
      if (p) socket.emit('your_role', { role: room.config.hiddenRole ? null : p.role, trueRole: p.role, word: p.word });
    }
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('update_config', ({ code, config }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.config = { ...defaultConfig(), ...config };
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('set_word_pairs', ({ code, pairs }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.wordPairs = pairs;
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const connectedPlayers = room.players.filter(p => p.connected);
    const n = connectedPlayers.length;
    const { numUndercover, numMrWhite } = room.config;
    if (n - numUndercover - numMrWhite < 1) return socket.emit('error', 'Pas assez de civils.');
    if (room.wordPairs.length === 0) return socket.emit('error', 'Aucune paire de mots.');
    // Only keep connected players for the game
    room.players = connectedPlayers;
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 1;
    room.logs = [];
    assignRoles(room);
    sendPrivateRoles(room);
    startWordPhase(room);
  });

  socket.on('give_word', ({ code, word }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'words') return;
    if (room.currentWordPlayer !== socket.id) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.wordsGiven.push(word);
    room.logs.push(`${p?.name} : "${word}"`);
    room.wordPlayerIndex++;
    clearTimers(room);
    advanceWordPlayer(room);
  });

  socket.on('vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'vote') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.eliminated) return;
    if (targetId === socket.id) return;
    // Don't allow changing vote
    if (room.votes[socket.id]) return;
    room.votes[socket.id] = targetId;
    room.voteRevealed[socket.id] = targetId;
    io.to(code).emit('game_state', publicState(room));
    checkAllVoted(room);
  });

  socket.on('mrwhite_guess', ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'mrwhite_guess') return;
    if (socket.id !== room.mrWhiteId) return;
    if (room._mrwhiteTimeout) { clearTimeout(room._mrwhiteTimeout); room._mrwhiteTimeout = null; }
    const correct = guess.trim().toLowerCase() === room.chosenPair.civ.toLowerCase();
    const mw = room.players.find(p => p.id === room.mrWhiteId);
    if (correct) {
      if (mw) mw.score += 4;
      room.logs.push(`Mr. White a deviné "${guess}" ! Bonus +4 points.`);
      endRound(room, 'mrwhite');
    } else {
      room.logs.push(`Mr. White a répondu "${guess}" — mauvais !`);
      endRoundAfterVote(room);
    }
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('next_round', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    nextRound(room);
  });

  socket.on('restart', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    resetRoomToLobby(room);
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(p => p.id === socket.id);
      if (!p) continue;

      p.connected = false;
      io.to(code).emit('game_state', publicState(room));

      // Reassign host if needed
      reassignHost(room);

      // If all disconnected, schedule cleanup
      if (room.players.every(p => !p.connected)) {
        clearTimers(room);
        setTimeout(() => {
          if (rooms[code] && rooms[code].players.every(p => !p.connected)) {
            clearTimers(rooms[code]);
            delete rooms[code];
          }
        }, 30 * 60 * 1000);
        break;
      }

      // If game is in progress and this player was the current word player, skip their turn
      if (room.phase === 'words' && room.currentWordPlayer === socket.id) {
        room.logs.push(`${p.name} s'est déconnecté, tour passé.`);
        clearTimers(room);
        room.wordPlayerIndex++;
        advanceWordPlayer(room);
      }

      // If game is in vote phase, check if all remaining connected players voted
      if (room.phase === 'vote') {
        checkAllVoted(room);
      }

      break;
    }
  });
});

function roleLabel(r) {
  if (r === 'civilian') return 'Civil';
  if (r === 'undercover') return 'Undercover';
  return 'Mr. White';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
