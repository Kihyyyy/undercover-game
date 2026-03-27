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
      wordsGiven: p.wordsGiven || [],
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
    chosenPair: (room.phase === 'end' || room.phase === 'round_recap') ? room.chosenPair : null,
    allWordsGiven: room.players.map(p => ({ id: p.id, words: p.wordsGiven || [] })),
  };
}

function clearTimers(room) {
  if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }
  if (room._mrwhiteTimeout) { clearTimeout(room._mrwhiteTimeout); room._mrwhiteTimeout = null; }
}

function safeEmitState(room) {
  try {
    io.to(room.code).emit('game_state', publicState(room));
  } catch (e) {
    console.error(`[emit error] room ${room.code}:`, e.message);
  }
}

function startTick(room, duration, onEnd) {
  clearTimers(room);
  room.phase_timer = duration;
  room._tickInterval = setInterval(() => {
    try {
      // Stop if room was deleted
      if (!rooms[room.code]) {
        clearInterval(room._tickInterval);
        room._tickInterval = null;
        return;
      }
      room.phase_timer = Math.max(0, room.phase_timer - 1);
      io.to(room.code).emit('timer_tick', { time: room.phase_timer });
      if (room.phase_timer <= 0) {
        clearInterval(room._tickInterval);
        room._tickInterval = null;
        onEnd();
      }
    } catch (e) {
      console.error(`[tick error] room ${room.code}:`, e.message);
      clearInterval(room._tickInterval);
      room._tickInterval = null;
    }
  }, 1000);
}

function assignRoles(room) {
  const n = room.players.length;
  const { numUndercover, numMrWhite } = room.config;
  const numCivilian = Math.max(0, n - numUndercover - numMrWhite);
  let roles = [
    ...Array(numCivilian).fill('civilian'),
    ...Array(Math.min(numUndercover, n)).fill('undercover'),
    ...Array(Math.min(numMrWhite, Math.max(0, n - numUndercover))).fill('mrwhite'),
  ];
  // Pad if needed
  while (roles.length < n) roles.push('civilian');
  roles = shuffle(roles).slice(0, n);

  const pair = room.wordPairs[Math.floor(Math.random() * room.wordPairs.length)];
  const flip = Math.random() < 0.5;
  room.chosenPair = flip ? { civ: pair.spy, spy: pair.civ } : { civ: pair.civ, spy: pair.spy };
  room.players = shuffle(room.players);
  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.word = roles[i] === 'civilian' ? room.chosenPair.civ
           : roles[i] === 'undercover' ? room.chosenPair.spy
           : null;
    p.eliminated = false;
    p.roleRevealed = false;
    p.wordsGiven = [];
  });
}

function sendPrivateRoles(room) {
  room.players.forEach(p => {
    try {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('your_role', {
        role: room.config.hiddenRole ? null : p.role,
        trueRole: p.role,
        word: p.word,
      });
    } catch (e) {
      console.error(`[sendRole error] player ${p.name}:`, e.message);
    }
  });
}

function getAlive(room) {
  return room.players.filter(p => !p.eliminated);
}

function startWordPhase(room) {
  room.phase = 'words';
  room.wordPlayerIndex = 0;
  room.players.forEach(p => { p.wordsGiven = []; });
  advanceWordPlayer(room);
}

function advanceWordPlayer(room) {
  try {
    const alivePlayers = getAlive(room);
    const totalTurns = alivePlayers.length * room.config.wordsPerPlayer;

    if (alivePlayers.length === 0 || room.wordPlayerIndex >= totalTurns) {
      startVotePhase(room);
      return;
    }

    const playerIdx = room.wordPlayerIndex % alivePlayers.length;
    const currentPlayer = alivePlayers[playerIdx];

    // Auto-skip disconnected players
    if (!currentPlayer.connected) {
      room.logs.push(`${currentPlayer.name} est déconnecté, tour passé.`);
      room.wordPlayerIndex++;
      // Guard against infinite loop (all disconnected)
      const connectedAlive = alivePlayers.filter(p => p.connected);
      if (connectedAlive.length === 0) { startVotePhase(room); return; }
      advanceWordPlayer(room);
      return;
    }

    room.currentWordPlayer = currentPlayer.id;
    safeEmitState(room);
    startTick(room, room.config.wordTime, () => {
      if (rooms[room.code] && room.phase === 'words') {
        room.wordPlayerIndex++;
        advanceWordPlayer(room);
      }
    });
  } catch (e) {
    console.error(`[advanceWordPlayer error] room ${room.code}:`, e.message);
    // Fallback: go to vote
    startVotePhase(room);
  }
}

function startVotePhase(room) {
  room.phase = 'vote';
  room.votes = {};
  room.voteRevealed = {};
  room.currentWordPlayer = null;
  safeEmitState(room);
  startTick(room, room.config.voteTime, () => {
    if (rooms[room.code] && room.phase === 'vote') {
      tallyVotes(room);
    }
  });
}

function checkAllVoted(room) {
  try {
    const connectedAlive = getAlive(room).filter(p => p.connected);
    if (connectedAlive.length === 0) { tallyVotes(room); return; }
    const allVoted = connectedAlive.every(p => room.votes[p.id]);
    if (allVoted) {
      clearTimers(room);
      tallyVotes(room);
    }
  } catch (e) {
    console.error(`[checkAllVoted error]:`, e.message);
  }
}

function tallyVotes(room) {
  try {
    clearTimers(room);
    const alivePlayers = getAlive(room);
    if (alivePlayers.length === 0) { endRoundAfterVote(room); return; }

    const tally = {};
    alivePlayers.forEach(p => { tally[p.id] = 0; });
    Object.values(room.votes).forEach(tid => {
      if (tally[tid] !== undefined) tally[tid]++;
    });

    // If nobody voted, pick random
    const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
    if (totalVotes === 0) {
      const r = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      tally[r.id] = 1;
    }

    const maxVotes = Math.max(...Object.values(tally));
    const candidates = Object.entries(tally).filter(([, v]) => v === maxVotes).map(([k]) => k);
    const eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
    const target = room.players.find(p => p.id === eliminatedId);

    const undercoverIds = room.players
      .filter(p => p.role === 'undercover' || p.role === 'mrwhite')
      .map(p => p.id);
    const unanimousVote = Object.values(room.votes).length > 0
      && Object.values(room.votes).every(v => v === eliminatedId);

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
        safeEmitState(room);
        const s = io.sockets.sockets.get(target.id);
        if (s) {
          s.emit('mrwhite_turn');
          room._mrwhiteTimeout = setTimeout(() => {
            if (rooms[room.code] && room.phase === 'mrwhite_guess') {
              room.logs.push(`Mr. White n'a pas répondu à temps.`);
              endRoundAfterVote(room);
              safeEmitState(room);
            }
          }, 30000);
        } else {
          room.logs.push(`Mr. White est déconnecté.`);
          endRoundAfterVote(room);
          safeEmitState(room);
        }
        return;
      }
    }

    endRoundAfterVote(room);
  } catch (e) {
    console.error(`[tallyVotes error] room ${room.code}:`, e.message);
    // Fallback: force end round
    try { endRound(room, 'civilian'); } catch (_) {}
  }
}

function endRoundAfterVote(room) {
  clearTimers(room);
  const alivePlayers = getAlive(room);
  const aliveUnder = alivePlayers.filter(p => p.role === 'undercover');
  const aliveCiv = alivePlayers.filter(p => p.role === 'civilian');

  let roundWinner;
  if (aliveUnder.length === 0 && alivePlayers.filter(p => p.role === 'mrwhite').length === 0) {
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
    players: room.players.map(p => ({
      id: p.id, name: p.name, role: p.role,
      word: p.word, score: p.score, avatar: p.avatar,
    })),
    chosenPair: room.chosenPair,
  };
  room.phase = 'round_recap';
  safeEmitState(room);
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
  room.finalScores = sorted.map((p, i) => ({
    rank: i + 1, id: p.id, name: p.name,
    avatar: p.avatar, score: p.score, role: p.role,
  }));
  safeEmitState(room);
}

function reassignHost(room) {
  const connected = room.players.filter(p => p.connected);
  if (connected.length > 0 && !connected.find(p => p.id === room.host)) {
    room.host = connected[0].id;
    room.logs.push(`${connected[0].name} est maintenant l'hôte.`);
  }
}

function resetRoomToLobby(room) {
  clearTimers(room);
  room.phase = 'lobby';
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

// ── SOCKET ─────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  function safeHandle(name, fn) {
    socket.on(name, (data) => {
      try { fn(data || {}); }
      catch (e) { console.error(`[socket error] event=${name} socket=${socket.id}:`, e.message); }
    });
  }

  safeHandle('create_room', ({ name, avatar }) => {
    if (!name) return;
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
    rooms[code].players.push({
      id: socket.id, name: String(name).slice(0, 16), avatar: avatar || '🦊',
      eliminated: false, connected: true, role: null, word: null,
      roleRevealed: false, wordsGiven: [], score: 0,
    });
    socket.emit('room_joined', { code, playerId: socket.id });
    safeEmitState(rooms[code]);
  });

  safeHandle('join_room', ({ code, name, avatar }) => {
    if (!code || !name) return;
    const room = rooms[String(code).toUpperCase()];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    if (room.phase !== 'lobby') return socket.emit('error', 'La partie a déjà commencé.');
    if (room.players.length >= 20) return socket.emit('error', 'Salon plein.');
    if (room.players.find(p => p.name === name && p.connected))
      return socket.emit('error', 'Ce pseudo est déjà utilisé.');
    socket.join(room.code);
    room.players.push({
      id: socket.id, name: String(name).slice(0, 16), avatar: avatar || '🦊',
      eliminated: false, connected: true, role: null, word: null,
      roleRevealed: false, wordsGiven: [], score: 0,
    });
    socket.emit('room_joined', { code: room.code, playerId: socket.id });
    safeEmitState(room);
  });

  safeHandle('rejoin_room', ({ code, name, avatar }) => {
    if (!code || !name) return;
    const room = rooms[String(code).toUpperCase()];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      const wasHost = room.host === existing.id;
      existing.id = socket.id;
      existing.connected = true;
      if (avatar) existing.avatar = avatar;
      if (wasHost) room.host = socket.id;
    } else {
      if (room.phase !== 'lobby') return socket.emit('error', 'Partie déjà commencée.');
      room.players.push({
        id: socket.id, name: String(name).slice(0, 16), avatar: avatar || '🦊',
        eliminated: false, connected: true, role: null, word: null,
        roleRevealed: false, wordsGiven: [], score: 0,
      });
    }
    reassignHost(room);
    socket.join(room.code);
    socket.emit('room_joined', { code: room.code, playerId: socket.id });
    socket.emit('game_state', publicState(room));
    if (room.phase !== 'lobby') {
      const p = room.players.find(p => p.id === socket.id);
      if (p) socket.emit('your_role', { role: room.config.hiddenRole ? null : p.role, trueRole: p.role, word: p.word });
    }
    safeEmitState(room);
  });

  safeHandle('update_config', ({ code, config }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.config = { ...defaultConfig(), ...config };
    safeEmitState(room);
  });

  safeHandle('set_word_pairs', ({ code, pairs }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (!Array.isArray(pairs)) return;
    room.wordPairs = pairs.filter(p => p && p.civ && p.spy);
    safeEmitState(room);
  });

  safeHandle('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const connectedPlayers = room.players.filter(p => p.connected);
    const n = connectedPlayers.length;
    const { numUndercover, numMrWhite } = room.config;
    if (n < 2) return socket.emit('error', 'Il faut au moins 2 joueurs.');
    if (n - numUndercover - numMrWhite < 1) return socket.emit('error', 'Pas assez de civils.');
    if (room.wordPairs.length === 0) return socket.emit('error', 'Aucune paire de mots.');
    room.players = connectedPlayers;
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 1;
    room.logs = [];
    assignRoles(room);
    sendPrivateRoles(room);
    startWordPhase(room);
  });

  safeHandle('give_word', ({ code, word }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'words') return;
    if (room.currentWordPlayer !== socket.id) return;
    if (!word || !String(word).trim()) return;
    const p = room.players.find(p => p.id === socket.id);
    const cleanWord = String(word).trim().slice(0, 30);
    if (p) p.wordsGiven.push(cleanWord);
    room.logs.push(`${p?.name} : "${cleanWord}"`);
    room.wordPlayerIndex++;
    clearTimers(room);
    advanceWordPlayer(room);
  });

  safeHandle('vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'vote') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.eliminated) return;
    if (targetId === socket.id) return;
    if (room.votes[socket.id]) return; // no changing vote
    const target = room.players.find(p => p.id === targetId && !p.eliminated);
    if (!target) return;
    room.votes[socket.id] = targetId;
    room.voteRevealed[socket.id] = targetId;
    safeEmitState(room);
    checkAllVoted(room);
  });

  safeHandle('mrwhite_guess', ({ code, guess }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'mrwhite_guess') return;
    if (socket.id !== room.mrWhiteId) return;
    clearTimers(room);
    const correct = String(guess).trim().toLowerCase() === room.chosenPair.civ.toLowerCase();
    const mw = room.players.find(p => p.id === room.mrWhiteId);
    if (correct) {
      if (mw) mw.score += 4;
      room.logs.push(`Mr. White a deviné "${guess}" ! Bonus +4 points.`);
      endRound(room, 'mrwhite');
    } else {
      room.logs.push(`Mr. White a répondu "${guess}" — mauvais !`);
      endRoundAfterVote(room);
    }
    safeEmitState(room);
  });

  safeHandle('next_round', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    nextRound(room);
  });

  safeHandle('restart', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    resetRoomToLobby(room);
    safeEmitState(room);
  });

  socket.on('disconnect', () => {
    try {
      for (const code in rooms) {
        const room = rooms[code];
        const p = room.players.find(p => p.id === socket.id);
        if (!p) continue;

        p.connected = false;
        reassignHost(room);
        safeEmitState(room);

        // All disconnected → schedule cleanup
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

        // Skip turn if this player was active
        if (room.phase === 'words' && room.currentWordPlayer === socket.id) {
          room.logs.push(`${p.name} s'est déconnecté, tour passé.`);
          clearTimers(room);
          room.wordPlayerIndex++;
          advanceWordPlayer(room);
        }

        // Trigger vote tally if everyone connected has voted
        if (room.phase === 'vote') {
          checkAllVoted(room);
        }

        break;
      }
    } catch (e) {
      console.error(`[disconnect error] socket=${socket.id}:`, e.message);
    }
  });
});

// Global uncaught exception guard — prevents full server crash
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e.message, e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});

function roleLabel(r) {
  if (r === 'civilian') return 'Civil';
  if (r === 'undercover') return 'Undercover';
  return 'Mr. White';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
