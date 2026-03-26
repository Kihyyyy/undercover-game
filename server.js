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
    wordsGivenThisRound: room.wordsGivenThisRound,
    mrWhiteId: room.mrWhiteId,
    chosenPair: room.phase === 'end' || room.phase === 'round_recap' ? room.chosenPair : null,
    allWordsGiven: room.players.map(p => ({ id: p.id, words: p.wordsGiven })),
  };
}

function clearTimers(room) {
  if (room._wordTimer) { clearTimeout(room._wordTimer); room._wordTimer = null; }
  if (room._voteTimer) { clearTimeout(room._voteTimer); room._voteTimer = null; }
  if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }
}

function startTick(room, duration, onEnd) {
  clearTimers(room);
  room.phase_timer = duration;
  room._tickInterval = setInterval(() => {
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
  // Randomly swap civ/spy words
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

function startWordPhase(room) {
  room.phase = 'words';
  room.wordPlayerIndex = 0;
  room.wordsGivenThisRound = {};
  room.players.forEach(p => { p.wordsGiven = []; });
  advanceWordPlayer(room);
}

function advanceWordPlayer(room) {
  const alive = room.players.filter(p => !p.eliminated);
  if (room.wordPlayerIndex >= alive.length * room.config.wordsPerPlayer) {
    startVotePhase(room);
    return;
  }
  const playerIdx = room.wordPlayerIndex % alive.length;
  room.currentWordPlayer = alive[playerIdx].id;
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

function tallyVotes(room) {
  clearTimers(room);
  const alive = room.players.filter(p => !p.eliminated);
  const tally = {};
  alive.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(tid => { if (tally[tid] !== undefined) tally[tid]++; });

  const maxVotes = Math.max(...Object.values(tally), 0);
  const candidates = Object.entries(tally).filter(([, v]) => v === maxVotes).map(([k]) => k);
  const eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
  const target = room.players.find(p => p.id === eliminatedId);

  const undercoverIds = room.players.filter(p => p.role === 'undercover' || p.role === 'mrwhite').map(p => p.id);
  const unanimousVote = Object.values(room.votes).every(v => v === eliminatedId);

  Object.entries(room.votes).forEach(([voterId, targetId]) => {
    const voter = room.players.find(p => p.id === voterId);
    if (!voter) return;
    if (undercoverIds.includes(targetId)) {
      voter.score += 2;
      if (unanimousVote) voter.score += 1;
    }
  });

  room.players.filter(p => p.role === 'undercover' || p.role === 'mrwhite').forEach(p => {
    if (!p.eliminated && p.id !== eliminatedId) {
      p.score += 3;
    }
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
      const s = io.sockets.sockets.get(target.id);
      if (s) s.emit('mrwhite_turn');
      return;
    }
  }

  // Always end round after one vote
  endRoundAfterVote(room);
}

function endRoundAfterVote(room) {
  const alive = room.players.filter(p => !p.eliminated);
  const aliveUnder = alive.filter(p => p.role === 'undercover');
  const aliveWhite = alive.filter(p => p.role === 'mrwhite');
  const aliveCiv = alive.filter(p => p.role === 'civilian');

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
  room.phase = 'end';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  room.finalScores = sorted.map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, score: p.score, role: p.role }));
  io.to(room.code).emit('game_state', publicState(room));
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, avatar }) => {
    const code = makeCode();
    rooms[code] = {
      code, phase: 'lobby', host: socket.id,
      players: [], config: defaultConfig(),
      wordPairs: [], chosenPair: null,
      currentRound: 1, distributeIndex: 0,
      currentWordPlayer: null, wordPlayerIndex: 0,
      wordsGivenThisRound: {}, votes: {}, voteRevealed: {},
      logs: [], roundRecap: null, finalScores: null,
      phase_timer: 0, mrWhiteId: null,
      _wordTimer: null, _voteTimer: null, _tickInterval: null,
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
    socket.join(code);
    room.players.push({ id: socket.id, name, avatar, eliminated: false, connected: true, role: null, word: null, roleRevealed: false, wordsGiven: [], score: 0 });
    socket.emit('room_joined', { code, playerId: socket.id });
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('rejoin_room', ({ code, name, avatar }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
      if (avatar) existing.avatar = avatar;
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
    const n = room.players.length;
    const { numUndercover, numMrWhite } = room.config;
    if (n - numUndercover - numMrWhite < 1) return socket.emit('error', 'Pas assez de civils.');
    if (room.wordPairs.length === 0) return socket.emit('error', 'Aucune paire de mots.');
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
    if (targetId === socket.id) return; // Cannot vote for yourself
    room.votes[socket.id] = targetId;
    room.voteRevealed[socket.id] = targetId;
    io.to(code).emit('game_state', publicState(room));
    const alive = room.players.filter(p => !p.eliminated);
    if (Object.keys(room.votes).length >= alive.length) {
      clearTimers(room);
      tallyVotes(room);
    }
  });

  socket.on('mrwhite_guess', ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'mrwhite_guess') return;
    if (socket.id !== room.mrWhiteId) return;
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
    clearTimers(room);
    room.phase = 'lobby';
    room.players.forEach(p => { p.role = null; p.word = null; p.eliminated = false; p.roleRevealed = false; p.wordsGiven = []; p.score = 0; });
    room.currentRound = 1; room.distributeIndex = 0;
    room.votes = {}; room.voteRevealed = {}; room.logs = [];
    room.roundRecap = null; room.finalScores = null;
    io.to(code).emit('game_state', publicState(room));
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(p => p.id === socket.id);
      if (p) {
        p.connected = false;
        io.to(code).emit('game_state', publicState(room));
        if (room.players.every(p => !p.connected)) {
          setTimeout(() => {
            if (rooms[code] && rooms[code].players.every(p => !p.connected)) {
              clearTimers(rooms[code]);
              delete rooms[code];
            }
          }, 30 * 60 * 1000);
        }
        break;
      }
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
