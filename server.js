const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory game rooms ──────────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRoom(code) { return rooms[code]; }

function roomPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    host: room.host,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      eliminated: p.eliminated,
      connected: p.connected,
      roleRevealed: p.roleRevealed,
    })),
    round: room.round,
    logs: room.logs,
    votes: room.votes,
    wordPairs: room.wordPairs,
    config: room.config,
    distributeIndex: room.distributeIndex,
    winner: room.winner,
    revealAll: room.revealAll,
  };
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── CREATE ROOM ──
  socket.on('create_room', ({ name }) => {
    const code = makeCode();
    rooms[code] = {
      code,
      phase: 'lobby',
      host: socket.id,
      players: [],
      config: { numUndercover: 1, numMrWhite: 0 },
      wordPairs: [],
      chosenPair: null,
      distributeIndex: 0,
      round: 1,
      logs: [],
      votes: {},
      winner: null,
      revealAll: false,
    };
    socket.join(code);
    rooms[code].players.push({ id: socket.id, name, eliminated: false, connected: true, role: null, word: null, roleRevealed: false });
    socket.emit('room_joined', { code, playerId: socket.id });
    io.to(code).emit('game_state', roomPublicState(rooms[code]));
  });

  // ── JOIN ROOM ──
  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('error', 'Salon introuvable.');
    if (room.phase !== 'lobby') return socket.emit('error', 'La partie a déjà commencé.');
    if (room.players.length >= 20) return socket.emit('error', 'Salon plein.');
    socket.join(code);
    room.players.push({ id: socket.id, name, eliminated: false, connected: true, role: null, word: null, roleRevealed: false });
    socket.emit('room_joined', { code, playerId: socket.id });
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── REJOIN (reconnect) ──
  socket.on('rejoin_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('error', 'Salon introuvable.');
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
    } else {
      if (room.phase !== 'lobby') return socket.emit('error', 'La partie a déjà commencé.');
      room.players.push({ id: socket.id, name, eliminated: false, connected: true, role: null, word: null, roleRevealed: false });
    }
    socket.join(code);
    socket.emit('room_joined', { code, playerId: socket.id });
    socket.emit('game_state', roomPublicState(room));
    // Send private role info if game started
    if (room.phase !== 'lobby') {
      const p = room.players.find(p => p.id === socket.id);
      if (p) socket.emit('your_role', { role: p.role, word: p.word });
    }
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── UPDATE CONFIG (host only) ──
  socket.on('update_config', ({ code, config }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.config = config;
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── SET WORD PAIRS (host only) ──
  socket.on('set_word_pairs', ({ code, pairs }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.wordPairs = pairs;
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── START GAME (host only) ──
  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    const { numUndercover, numMrWhite } = room.config;
    const n = room.players.length;
    const numCivilian = n - numUndercover - numMrWhite;
    if (numCivilian < 1) return socket.emit('error', 'Pas assez de civils.');
    if (room.wordPairs.length === 0) return socket.emit('error', 'Aucune paire de mots.');

    const pair = room.wordPairs[Math.floor(Math.random() * room.wordPairs.length)];
    room.chosenPair = pair;

    let roles = [
      ...Array(numCivilian).fill('civilian'),
      ...Array(numUndercover).fill('undercover'),
      ...Array(numMrWhite).fill('mrwhite'),
    ];
    roles = shuffle(roles);
    room.players = shuffle(room.players);
    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.word = roles[i] === 'civilian' ? pair.civ : roles[i] === 'undercover' ? pair.spy : null;
      p.eliminated = false;
      p.roleRevealed = false;
    });

    room.phase = 'distribute';
    room.distributeIndex = 0;
    room.round = 1;
    room.logs = ['La partie commence !'];
    room.votes = {};
    room.winner = null;
    room.revealAll = false;

    io.to(code).emit('game_state', roomPublicState(room));

    // Send each player their private role
    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('your_role', { role: p.role, word: p.word });
    });
  });

  // ── PLAYER CONFIRMS ROLE SEEN ──
  socket.on('role_seen', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.roleRevealed = true;
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── HOST ADVANCES DISTRIBUTION ──
  socket.on('next_distribute', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.distributeIndex++;
    if (room.distributeIndex >= room.players.length) {
      room.phase = 'game';
    }
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── VOTE ──
  socket.on('vote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.eliminated) return;
    room.votes[socket.id] = targetId;
    room.logs.push(`${voter.name} a voté.`);

    const alivePlayers = room.players.filter(p => !p.eliminated);
    if (Object.keys(room.votes).length >= alivePlayers.length) {
      // Tally votes
      const tally = {};
      Object.values(room.votes).forEach(tid => { tally[tid] = (tally[tid] || 0) + 1; });
      const maxVotes = Math.max(...Object.values(tally));
      const eliminated = Object.entries(tally).filter(([, v]) => v === maxVotes).map(([k]) => k);
      const targetId = eliminated[Math.floor(Math.random() * eliminated.length)];
      const target = room.players.find(p => p.id === targetId);
      if (target) {
        target.eliminated = true;
        room.logs.push(`${target.name} est éliminé ! (${roleLabel(target.role)})`);
        if (target.role === 'mrwhite') {
          room.phase = 'mrwhite_guess';
          room.mrWhiteId = target.id;
        } else {
          checkWin(room);
        }
      }
      room.votes = {};
      room.round++;
    }
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── MR WHITE GUESS ──
  socket.on('mrwhite_guess', ({ code, guess }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'mrwhite_guess') return;
    if (socket.id !== room.mrWhiteId) return;
    const correct = guess.trim().toLowerCase() === room.chosenPair.civ.toLowerCase();
    if (correct) {
      room.winner = 'mrwhite';
      room.logs.push(`Mr. White a deviné "${guess}" — Mr. White gagne !`);
      room.phase = 'end';
      room.revealAll = true;
    } else {
      room.logs.push(`Mr. White a répondu "${guess}" — mauvais ! Les civils continuent.`);
      room.phase = 'game';
      checkWin(room);
    }
    io.to(code).emit('game_state', roomPublicState(room));
    if (room.phase === 'end') {
      sendReveal(room);
    }
  });

  // ── NEXT ROUND (host) ──
  socket.on('next_round', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.logs.push(`--- Tour ${room.round} ---`);
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── RESTART (host) ──
  socket.on('restart', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.phase = 'lobby';
    room.players.forEach(p => { p.role = null; p.word = null; p.eliminated = false; p.roleRevealed = false; });
    room.distributeIndex = 0;
    room.round = 1;
    room.logs = [];
    room.votes = {};
    room.winner = null;
    room.revealAll = false;
    io.to(code).emit('game_state', roomPublicState(room));
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(p => p.id === socket.id);
      if (p) {
        p.connected = false;
        io.to(code).emit('game_state', roomPublicState(room));
        // Clean up empty rooms after 30 min
        if (room.players.every(p => !p.connected)) {
          setTimeout(() => {
            if (rooms[code] && rooms[code].players.every(p => !p.connected)) delete rooms[code];
          }, 30 * 60 * 1000);
        }
        break;
      }
    }
  });
});

// ── Helpers ──
function roleLabel(role) {
  if (role === 'civilian') return 'Civil';
  if (role === 'undercover') return 'Undercover';
  return 'Mr. White';
}

function checkWin(room) {
  const alive = room.players.filter(p => !p.eliminated);
  const aliveUnder = alive.filter(p => p.role === 'undercover');
  const aliveWhite = alive.filter(p => p.role === 'mrwhite');
  const aliveCiv = alive.filter(p => p.role === 'civilian');

  if (aliveUnder.length === 0 && aliveWhite.length === 0) {
    room.winner = 'civilian';
    room.logs.push('Les civils ont gagné ! Tous les imposteurs sont éliminés.');
    room.phase = 'end';
    room.revealAll = true;
    sendReveal(room);
  } else if (aliveUnder.length >= aliveCiv.length) {
    room.winner = 'undercover';
    room.logs.push('L\'Undercover gagne ! Les civils sont en minorité.');
    room.phase = 'end';
    room.revealAll = true;
    sendReveal(room);
  }
}

function sendReveal(room) {
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('reveal', {
      role: p.role,
      word: p.word,
      chosenPair: room.chosenPair,
      players: room.players.map(pl => ({ name: pl.name, role: pl.role, word: pl.word, eliminated: pl.eliminated }))
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Undercover server running on port ${PORT}`));
