const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const state = {
  players: [],
  transactions: [],
  chatRooms: { 1: [], 2: [], 3: [] },
};

const users = {};

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createPlayer(name, initialFlark = 10, initialPotential = 0) {
  const id = Math.random().toString(36).slice(2, 10);
  const potential = state.players.length < 20 ? 20 : initialPotential || 0;
  const player = { id, name, flark: initialFlark, potential };
  state.players.push(player);
  return player;
}

function addTransaction(from, to, amount) {
  const text = `${from} gave ${to} ${amount.toFixed(1)} Glark (to Potential)`;
  state.transactions.unshift({ from, to, amount: Number(amount.toFixed(1)), text, time: Date.now() });
  if (state.transactions.length > 200) state.transactions.pop();
}

function broadcastState() {
  io.emit('state', {
    players: state.players,
    transactions: state.transactions,
    chatRooms: state.chatRooms,
  });
}

function resolvePlayerById(id) {
  return state.players.find(p => p.id === id);
}

function registerUser(username, password) {
  const key = username.trim().toLowerCase();
  if (!username || !password || username.length < 3 || password.length < 4) {
    return { success: false, message: 'Username 3+ chars, password 4+ chars required' };
  }
  if (users[key]) {
    return { success: false, message: 'Username already exists' };
  }

  const player = createPlayer(username.trim(), 10, 0);
  users[key] = {
    username: username.trim(),
    passwordHash: hashPassword(password),
    playerId: player.id,
  };

  return { success: true, username: username.trim(), playerId: player.id };
}

function loginUser(username, password) {
  if (!username || !password) return { success: false, message: 'Missing credentials' };
  const key = username.trim().toLowerCase();
  const user = users[key];
  if (!user) return { success: false, message: 'User not found' };
  if (user.passwordHash !== hashPassword(password)) return { success: false, message: 'Incorrect password' };
  return { success: true, username: user.username, playerId: user.playerId };
}

io.on('connection', socket => {
  console.log('client connected', socket.id);

  socket.on('register', ({ username, password }, callback) => {
    const result = registerUser(username, password);
    if (result.success) {
      socket.user = { username: result.username, playerId: result.playerId };
      callback({ success: true, playerId: result.playerId, username: result.username });
      broadcastState();
    } else {
      callback({ success: false, message: result.message });
    }
  });

  socket.on('login', ({ username, password }, callback) => {
    const result = loginUser(username, password);
    if (result.success) {
      socket.user = { username: result.username, playerId: result.playerId };
      callback({ success: true, playerId: result.playerId, username: result.username });
    } else {
      callback({ success: false, message: result.message });
    }
  });

  socket.on('join', callback => {
    callback({ players: state.players, transactions: state.transactions, chatRooms: state.chatRooms });
  });

  socket.on('create_player', name => {
    if (!socket.user) return;
    if (!name || !name.trim()) return;
    createPlayer(name.trim(), 50, 0);
    broadcastState();
  });

  socket.on('convert_potential', ({ playerId }) => {
    if (!socket.user || socket.user.playerId !== playerId) return;
    const player = resolvePlayerById(playerId);
    if (!player || player.potential <= 0) return;
    player.flark += player.potential;
    player.potential = 0;
    broadcastState();
  });

  socket.on('send_potential', ({ fromId, toId, amount }) => {
    if (!socket.user || socket.user.playerId !== fromId) return;
    const from = resolvePlayerById(fromId);
    const to = resolvePlayerById(toId);
    const amountN = Number(amount);
    if (!from || !to || !Number.isFinite(amountN) || amountN <= 0) return;
    if (from.flark < amountN) return;
    from.flark -= amountN;
    to.potential += amountN;
    addTransaction(from.name, to.name, amountN);
    broadcastState();
  });

  socket.on('send_chat', ({ playerId, room, text }) => {
    if (!socket.user || socket.user.playerId !== playerId) return;
    const player = resolvePlayerById(playerId);
    const roomId = Number(room);
    if (!player || !text || !text.trim() || !state.chatRooms[roomId]) return;
    state.chatRooms[roomId].push({ from: player.name, text: text.trim(), time: Date.now() });
    if (state.chatRooms[roomId].length > 300) state.chatRooms[roomId].shift();
    broadcastState();
  });

  socket.on('logout', () => {
    socket.user = null;
  });

  socket.on('disconnect', () => console.log('client disconnected', socket.id));
});

// hourly decay; 60*60*1000 ms to match spec.
setInterval(() => {
  state.players.forEach(p => {
    p.flark = Math.max(0, p.flark - 1);
  });
  broadcastState();
}, 60 * 60 * 1000);

// quick debug timer if env set.
if (process.env.DEBUG_QUICK) {
  setInterval(() => {
    state.players.forEach(p => { p.flark = Math.max(0, p.flark - 1); });
    broadcastState();
  }, 10000);
}

// bootstrap initial players
createPlayer('Alice', 10, 0);
createPlayer('Bob', 10, 0);
createPlayer('Carmen', 10, 0);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Glark server running on http://localhost:${PORT}`));
