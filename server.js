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
  createPlayer('Alice');
  createPlayer('Bob');
  createPlayer('Carmen');
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

// Round to 8 decimal places to avoid floating-point drift.
function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

// Multiplier derived from current glark using 10-point bucket:
// bucket = floor(glark / 10) * 10; multiplier = 1 + 0.0001 * bucket.
// Multiplier changes only at glark 0, 10, 20, 30, …
function computeMultiplierFromGlark(glark) {
  const g = Number(glark);
  if (!Number.isFinite(g) || g < 0) return 1.0;
  const bucket = Math.floor(g / 10) * 10;
  return 1.0 + 0.0001 * bucket;
}

// Migrate persisted players: rename flark→glark, remove potential.
// Recompute multiplier from glark for all players.
// Ensure lifetimeMaxGlark and trophiesEarned fields exist.
state.players.forEach(p => {
  if (p.glark === undefined) {
    p.glark = typeof p.flark === 'number' ? p.flark : 10;
  }
  delete p.flark;
  delete p.potential;
  p.multiplier = computeMultiplierFromGlark(p.glark);
  if (typeof p.multiplier !== 'number' || !Number.isFinite(p.multiplier)) {
    p.multiplier = 1.0;
  }
  if (typeof p.lifetimeMaxGlark !== 'number') p.lifetimeMaxGlark = p.glark;
  if (!Array.isArray(p.trophiesEarned)) p.trophiesEarned = [];
});

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Glark milestone thresholds for trophy awards.
const GLARK_MILESTONES = [
  100, 1000, 10000, 100000, 1000000, 10000000, 100000000,
  1000000000, 10000000000, 100000000000, 1000000000000,
];

// In-memory placement counters: how many players have earned each milestone this server run.
// Resets on every server restart (in-memory only, by design).
const milestonePlacement = {};
for (const m of GLARK_MILESTONES) milestonePlacement[m] = 0;

// In-memory count of players created since server start. Resets on every deploy/restart.
// The first 20 players created in each server lifetime receive the starter bonus (50 glark).
let playersCreatedThisRun = 0;

function createPlayer(name, initialGlark = 10) {
  const id = Math.random().toString(36).slice(2, 10);

  // First 20 players created since server start receive 50 Glark; everyone else gets 10.
  const glark = playersCreatedThisRun < 20 ? 50 : initialGlark;
  playersCreatedThisRun++;

  const player = {
    id,
    name,
    glark,
    multiplier: computeMultiplierFromGlark(glark),
    lifetimeMaxGlark: glark,
    trophiesEarned: [],
  };

  state.players.push(player);
  return player;
}

function addTransaction(from, to, amount) {
  const text = `${from} gave ${to} ${amount.toFixed(1)} Glark`;
  state.transactions.unshift({
    from,
    to,
    amount: Number(amount.toFixed(1)),
    text,
    time: Date.now(),
  });
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

/**
 * Update a player's lifetime max glark and award any newly crossed milestone trophies.
 * Emits a 'trophy' event on the player's connected socket (if any).
 * Returns true if lifetimeMaxGlark changed (signals that a save may be needed).
 */
function checkTrophies(player) {
  if (!player) return false;
  const newMax = Math.max(player.lifetimeMaxGlark || 0, player.glark || 0);
  const changed = newMax !== player.lifetimeMaxGlark;
  player.lifetimeMaxGlark = newMax;

  for (const milestone of GLARK_MILESTONES) {
    if (newMax >= milestone && !player.trophiesEarned.includes(milestone)) {
      player.trophiesEarned.push(milestone);
      milestonePlacement[milestone] += 1;
      const placement = milestonePlacement[milestone];
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.playerId === player.id) {
          s.emit('trophy', { milestone, placement });
          break;
        }
      }
    }
  }

  return changed;
}

function registerUser(username, password) {
  const key = username.trim().toLowerCase();
  if (!username || !password || username.length < 3 || password.length < 4) {
    return {
      success: false,
      message: 'Username 3+ chars, password 4+ chars required',
    };
  }
  if (users[key]) {
    return { success: false, message: 'Username already exists' };
  }

  // createPlayer() owns the starting-balance rule.
  const player = createPlayer(username.trim());
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
  emitTickInfo(socket);

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
    createPlayer(name.trim());
    broadcastState();
  });

  socket.on('send_glark', ({ fromId, toId, amount }, callback) => {
    const respond = (typeof callback === 'function') ? callback : () => {};
    if (!socket.user || socket.user.playerId !== fromId) return respond({ success: false, message: 'Unauthorized' });
    const from = resolvePlayerById(fromId);
    const to = resolvePlayerById(toId);
    const amountN = Number(amount);
    if (!from || !to || !Number.isFinite(amountN) || amountN <= 0) return respond({ success: false, message: 'Invalid transfer' });
    if (from.glark < amountN) return respond({ success: false, message: 'Not enough Glark to send.' });
    if (from.glark - amountN < 10) return respond({ success: false, message: 'You must keep at least 10 Glark after transferring.' });
    from.glark = round8(from.glark - amountN);
    to.glark = round8(to.glark + amountN);
    from.multiplier = computeMultiplierFromGlark(from.glark);
    to.multiplier = computeMultiplierFromGlark(to.glark);
    checkTrophies(to);
    addTransaction(from.name, to.name, amountN);
    broadcastState();
    respond({ success: true });
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

// Single tick loop: runs every 2 minutes.
// Each tick applies decay (-1 Glark, floored at 0) then growth (multiplier-based).
const TICK_INTERVAL_MS = 120000;
let nextTickAt = Date.now() + TICK_INTERVAL_MS;

function emitTickInfo(target) {
  (target || io).emit('tick_info', { tickIntervalMs: TICK_INTERVAL_MS, nextTickAt });
}

setInterval(() => {
  let changed = false;
  state.players.forEach(p => {
    // Decay: lose 1 Glark per tick, floored at 0.
    const afterDecay = round8(Math.max(0, (Number(p.glark) || 0) - 1));

    if (afterDecay === 0) {
      if (p.glark !== 0 || p.multiplier !== 1) {
        p.glark = 0;
        p.multiplier = 1;
        changed = true;
      }
      return;
    }

    // Growth: fixed-point iteration to apply multiplier derived from new glark.
    const FIXEDPOINT_ITERATIONS = 3;
    let guess = afterDecay;
    for (let i = 0; i < FIXEDPOINT_ITERATIONS; i++) {
      const bucket = Math.floor(guess / 10) * 10;
      const mult = 1 + 0.0001 * bucket;
      guess = round8(afterDecay * mult);
    }

    const newMultiplier = computeMultiplierFromGlark(guess);

    if (p.glark !== guess) { p.glark = guess; changed = true; }
    if (p.multiplier !== newMultiplier) { p.multiplier = newMultiplier; changed = true; }
    if (checkTrophies(p)) changed = true;
  });

  if (changed) broadcastState();
  // Update nextTickAt after processing so the emitted timestamp reflects the
  // true time until the next interval fires (minimises client drift).
  nextTickAt = Date.now() + TICK_INTERVAL_MS;
  emitTickInfo();
}, TICK_INTERVAL_MS);

// Bootstrap initial players only when starting fresh (no persisted data).
if (state.players.length === 0) {
  createPlayer('Alice');
  createPlayer('Bob');
  createPlayer('Carmen');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Glark server running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_RESET_TOKEN) {
    console.warn(
      'WARNING: ADMIN_RESET_TOKEN is not set. The /admin/reset-save endpoint will reject all requests.'
    );
  }
});
