/**
 * persist.js – server-side persistence for Glark Exchange.
 *
 * Saves game state (players, transactions, chatRooms) and user credentials to
 * a local JSON file (DATA_FILE) so data survives server restarts/redeployments.
 *
 * Writes are debounced (DEBOUNCE_MS) to avoid hammering disk on rapid changes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const SAVE_KEY_VERSION = 'text_game_save_v1';
const DEBOUNCE_MS = 200;

let _saveTimer = null;

/**
 * Load persisted data from disk.
 * Returns an object with `state` and `users`, merged with the provided defaults
 * so that new fields added in future versions get sensible initial values.
 *
 * @param {{ state: object, users: object }} defaults
 * @returns {{ state: object, users: object }}
 */
function loadData(defaults) {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { state: defaults.state, users: defaults.users };
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed.__version !== SAVE_KEY_VERSION) {
      // Future: handle migration here. For now, fall back to defaults.
      console.warn('[persist] Save file version mismatch – starting fresh.');
      return { state: defaults.state, users: defaults.users };
    }

    // Shallow-merge top-level state keys so new fields get defaults.
    const state = Object.assign({}, defaults.state, parsed.state || {});

    // Ensure all chat room keys exist (new rooms added later keep defaults).
    state.chatRooms = Object.assign({}, defaults.state.chatRooms, state.chatRooms || {});

    const users = Object.assign({}, defaults.users, parsed.users || {});

    console.log(
      `[persist] Loaded ${state.players.length} players, ` +
      `${state.transactions.length} transactions from ${DATA_FILE}`
    );

    return { state, users };
  } catch (err) {
    console.error('[persist] Failed to load data – starting fresh.', err.message);
    return { state: defaults.state, users: defaults.users };
  }
}

/**
 * Persist current state and users to disk immediately.
 * @param {{ state: object, users: object }} data
 */
function saveDataNow(data) {
  try {
    const payload = JSON.stringify({ __version: SAVE_KEY_VERSION, ...data }, null, 2);
    fs.writeFileSync(DATA_FILE, payload, 'utf8');
  } catch (err) {
    console.error('[persist] Failed to save data.', err.message);
  }
}

/**
 * Schedule a debounced save.  Calling this repeatedly only triggers one write
 * after DEBOUNCE_MS of inactivity, reducing disk I/O on rapid state changes.
 * @param {{ state: object, users: object }} data
 */
function requestSave(data) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveDataNow(data), DEBOUNCE_MS);
}

module.exports = { loadData, saveDataNow, requestSave };
