const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { loadData, requestSave } = require('./persist');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

// ---------------------------------------------------------------------------
// Admin-only reset endpoint – protected by ADMIN_RESET_TOKEN env variable.
// Normal players have no UI access to this; it is intended for admin use only.
//
// Usage (replace <token> with the value of your ADMIN_RESET_TOKEN env var):
//   curl -X POST https://<your-render-url>/admin/reset-save \
//        -H "x-admin-token: <token>"
// ---------------------------------------------------------------------------
app.post('/admin/reset-save', (req, res) => {
  const adminToken = process.env.ADMIN_RESET_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!adminToken || !provided) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  // Use constant-time comparison to prevent timing-based token enumeration.
  const tokBuf = Buffer.from(adminToken);
  const reqBuf = Buffer.from(provided);
  const tokenMatch =
    tokBuf.length === reqBuf.length && crypto.timingSafeEqual(tokBuf, reqBuf);
  if (!tokenMatch) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  // Clear all runtime state and users, then persist the empty slate.
  state.players.length = 0;
  state.transactions.length = 0;
  state.chatRooms[1] = [];
  state.chatRooms[2] = [];
  state.chatRooms[3] = [];
  for (const key of Object.keys(users)) delete users[key];
  // Clear socket.user on every connected socket so stale references can't
  // be used to perform actions on the now-empty state.
  for (const [, s] of io.sockets.sockets) s.user = null;
  createPlayer('Alice', 10, 0);
  createPlayer('Bob', 10, 0);
  createPlayer('Carmen', 10, 0);
  broadcastState();
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Persistent state – loaded from disk on startup, saved after every mutation.
// ---------------------------------------------------------------------------
const defaultState = {
  players: [],
  transactions: [],
  chatRooms: { 1: [], 2: [], 3: [] },
};
const defaultUsers = {};

const loaded = loadData({ state: defaultState, users: defaultUsers });
const state = loaded.state;
const users = loaded.users;

// Backfill multiplier for players saved before this field was introduced,
// and recompute for all existing players to match current flark.
state.players.forEach(p => {
  p.multiplier = computeMultiplierFromFlark(p.flark);
});

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Round to 8 decimal places to avoid floating-point drift.
function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

// Multiplier derived from current flark balance: default x1.0, +0.5 per 50 flark.
function computeMultiplierFromFlark(flark) {
  const f = Number(flark);
  if (!Number.isFinite(f) || f < 0) return 1.0;
  return 1.0 + 0.5 * Math.floor(f / 50);
}

function createPlayer(name, initialFlark = 10, initialPotential = 0) {
  const id = Math.random().toString(36).slice(2, 10);
  const potential = state.players.length < 20 ? 20 : initialPotential || 0;
  const player = { id, name, flark: initialFlark, potential, multiplier: computeMultiplierFromFlark(initialFlark) };
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
  requestSave({ state, users });
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
      broadcastState(); // also calls requestSave
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
    if (from.flark - amountN < 10) return;
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

// hourly decay; temporarily set to 10 s for testing (was 60 * 60 * 1000).
const TESTING_DECAY_INTERVAL_MS = 10_000; // TODO: revert to 60 * 60 * 1000 after testing
setInterval(() => {
  state.players.forEach(p => {
    p.flark = Math.max(0, p.flark - 1);
    if (p.flark === 0) p.potential = 0;
  });
  broadcastState();
}, TESTING_DECAY_INTERVAL_MS);

// Potential growth: every tick compute multiplier from current flark, then multiply potential.
const POTENTIAL_TICK_MS = 10_000; // TODO: revert to 60 * 60 * 1000 (1 hour) after testing
setInterval(() => {
  let changed = false;
  state.players.forEach(p => {
    const mult = computeMultiplierFromFlark(p.flark);
    if (p.multiplier !== mult) {
      p.multiplier = mult;
      changed = true;
    }
    const pot = Number(p.potential);
    if (!Number.isFinite(pot) || pot <= 0) return;
    const next = round8(pot * mult);
    if (next !== p.potential) {
      p.potential = next;
      changed = true;
    }
  });
  if (changed) broadcastState();
}, POTENTIAL_TICK_MS);

// quick debug timer if env set.
if (process.env.DEBUG_QUICK) {
  setInterval(() => {
    state.players.forEach(p => { p.flark = Math.max(0, p.flark - 1); });
    broadcastState();
  }, 10000);
}

// Bootstrap initial players only when starting fresh (no persisted data).
if (state.players.length === 0) {
  createPlayer('Alice', 10, 0);
  createPlayer('Bob', 10, 0);
  createPlayer('Carmen', 10, 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Glark server running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_RESET_TOKEN) {
    console.warn('WARNING: ADMIN_RESET_TOKEN is not set. The /admin/reset-save endpoint will reject all requests.');
  }
});
