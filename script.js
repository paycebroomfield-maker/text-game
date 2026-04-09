const socket = io();
let gameState = { players: [], transactions: [], chatRooms: {1: [], 2: [], 3: []} };
let currentPlayerId = null;
let currentUsername = null;
let activeChatRoom = 1;
let transferTargetPlayer = null;
let itemSelectionTarget = null;

// Tick countdown state
let nextTickAt = null;
const tickValueEl = document.getElementById('tickValue');

function updateTickDisplay() {
  if (!nextTickAt) return;
  const msLeft = Math.max(0, nextTickAt - Date.now());
  const totalSecs = Math.ceil(msLeft / 1000);
  const mm = String(Math.floor(totalSecs / 60)).padStart(2, '0');
  const ss = String(totalSecs % 60).padStart(2, '0');
  tickValueEl.textContent = `${mm}:${ss}`;
}

setInterval(updateTickDisplay, 1000);

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showTrophyOverlay(milestone, placement) {
  const milestoneStr = Number(milestone).toLocaleString();
  const placementStr = Number(placement).toLocaleString();
  const msg = document.getElementById('trophyMessage');
  msg.textContent = `Congratulations! You earned ${milestoneStr} Glark Trophy #${placementStr}.`;
  document.getElementById('trophyOverlay').classList.remove('hidden');
}

const elements = {
  authContainer: document.getElementById('authContainer'),
  gameContainer: document.getElementById('gameContainer'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authLoginBtn: document.getElementById('authLoginBtn'),
  authRegisterBtn: document.getElementById('authRegisterBtn'),
  authMessage: document.getElementById('authMessage'),
  glarkValue: document.getElementById('glarkValue'),
  multiplierValue: document.getElementById('multiplierValue'),
  plarkValue: document.getElementById('plarkValue'),
  transactionsList: document.getElementById('transactionsList'),
  txFilter: document.getElementById('txFilter'),
  chatFilter: document.getElementById('chatFilter'),
  chatLog: document.getElementById('chatLog'),
  chatMessage: document.getElementById('chatMessage'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  chatTabs: [...document.querySelectorAll('.chat-tab')],
  transferModal: document.getElementById('transferModal'),
  transferTarget: document.getElementById('transferTarget'),
  transferAmount: document.getElementById('transferAmount'),
  confirmTransfer: document.getElementById('confirmTransfer'),
  cancelTransfer: document.getElementById('cancelTransfer'),
};

// Format a number for display: round to 8 decimal places max, then trim trailing zeros.
// Multiplier increments are small (0.0001 per glark bucket of 10), so toFixed(2) looked stuck at 1.00.
function format8(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  let s = x.toFixed(8);
  s = s.replace(/\.?0+$/, '');
  return s;
}

function getCurrentPlayer() {
  return gameState.players.find(p => p.id === currentPlayerId);
}

function refreshPlayerGrid() {
  // removed: player grid is no longer in UI
}

function refreshStatus() {
  const player = getCurrentPlayer();
  if (!player) {
    elements.glarkValue.textContent = '0';
    elements.multiplierValue.textContent = 'x1';
    return;
  }
  elements.glarkValue.textContent = format8(player.glark);
  const mult = (typeof player.multiplier === 'number' && Number.isFinite(player.multiplier))
    ? player.multiplier
    : 1;
  elements.multiplierValue.textContent = `x${format8(mult)}`;
  elements.plarkValue.textContent = format8(player.plark || 0);
}

function clickTransactionName(name) {
  const target = gameState.players.find(p => p.name === name);
  if (!target) {
    showToast('Player not found in game yet.');
    return;
  }
  openTransfer(target.id);
}

function isNearBottom(el, threshold = 40) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function refreshTransactions() {
  const wasNearBottom = isNearBottom(elements.transactionsList);
  const query = elements.txFilter.value.trim().toLowerCase();
  elements.transactionsList.innerHTML = '';

  const filtered = gameState.transactions.filter(tx => {
    const text = tx.text || '';
    const names = `${tx.from || ''} ${tx.to || ''}`;
    return !query || text.toLowerCase().includes(query) || names.toLowerCase().includes(query);
  }).reverse();

  if (filtered.length === 0) {
    const placeholder = document.createElement('p');
    placeholder.textContent = 'No transactions yet.';
    placeholder.style.opacity = '0.7';
    elements.transactionsList.appendChild(placeholder);
    return;
  }

  filtered.forEach(tx => {
    const p = document.createElement('p');

    const fromName = tx.from || '';
    const toName = tx.to || '';
    const amount = Number(tx.amount);

    if (tx.item && fromName && toName) {
      const fromNode = document.createElement('strong');
      fromNode.textContent = fromName;
      fromNode.className = 'tx-name';
      fromNode.style.cursor = 'pointer';
      fromNode.onclick = () => clickTransactionName(fromName);

      const toNode = document.createElement('strong');
      toNode.textContent = toName;
      toNode.className = 'tx-name';
      toNode.style.cursor = 'pointer';
      toNode.onclick = () => clickTransactionName(toName);

      p.appendChild(fromNode);
      p.appendChild(document.createTextNode(' sent '));
      p.appendChild(toNode);
      p.appendChild(document.createTextNode(` a ${Number(tx.item.milestone).toLocaleString()} Glark Trophy`));
    } else if (fromName && toName && !Number.isNaN(amount)) {
      const fromNode = document.createElement('strong');
      fromNode.textContent = fromName;
      fromNode.className = 'tx-name';
      fromNode.style.cursor = 'pointer';
      fromNode.onclick = () => clickTransactionName(fromName);

      const toNode = document.createElement('strong');
      toNode.textContent = toName;
      toNode.className = 'tx-name';
      toNode.style.cursor = 'pointer';
      toNode.onclick = () => clickTransactionName(toName);

      p.appendChild(fromNode);
      p.appendChild(document.createTextNode(' gave '));
      p.appendChild(toNode);
      p.appendChild(document.createTextNode(` ${amount.toFixed(1)} Glark`));
    } else {
      p.textContent = tx.text || '';
    }

    elements.transactionsList.appendChild(p);
  });
  if (wasNearBottom) scrollToBottom(elements.transactionsList);
}

function refreshChat() {
  const wasNearBottom = isNearBottom(elements.chatLog);
  const query = elements.chatFilter.value.trim().toLowerCase();
  elements.chatLog.innerHTML = '';
  gameState.chatRooms[activeChatRoom].filter(msg => !query || msg.text.toLowerCase().includes(query) || msg.from.toLowerCase().includes(query)).forEach(msg => {
    const p = document.createElement('p');
    const nameNode = document.createElement('strong');
    nameNode.textContent = `${msg.from}: `;
    nameNode.className = 'chat-name';
    nameNode.style.cursor = 'pointer';
    nameNode.onclick = () => {
      const target = gameState.players.find(p => p.name === msg.from);
      if (!target) {
        showToast('Player not found in game yet.');
        return;
      }
      openTransfer(target.id);
    };
    p.appendChild(nameNode);
    p.appendChild(document.createTextNode(msg.text));
    elements.chatLog.appendChild(p);
  });
  if (wasNearBottom) scrollToBottom(elements.chatLog);
}

function showAuth(show, message = '') {
  if (show) {
    elements.authContainer.classList.remove('hidden');
    elements.gameContainer.classList.add('hidden');
  } else {
    elements.authContainer.classList.add('hidden');
    elements.gameContainer.classList.remove('hidden');
  }
  elements.authMessage.textContent = message;
}

function refreshAll() {
  refreshStatus();
  refreshTransactions();
  refreshChat();
  refreshItems();
}

function refreshItems() {
  const player = getCurrentPlayer();
  const list = document.querySelector('#itemsBox .items-list');
  if (!list) return;
  list.innerHTML = '';
  if (!player || !Array.isArray(player.items) || player.items.length === 0) {
    const p = document.createElement('p');
    p.className = 'items-empty';
    p.textContent = 'No items yet.';
    list.appendChild(p);
    return;
  }
  const count = player.items.length;
  const size = computeCircleSize(count);
  // Most recently acquired first.
  const itemsToShow = [...player.items].reverse();
  const tooltip = document.getElementById('itemTooltip');
  itemsToShow.forEach(item => {
    const circle = document.createElement('div');
    circle.className = `item-circle ${getItemColorClass(item.milestone)}`;
    circle.style.width = `${size}px`;
    circle.style.height = `${size}px`;
    const milestoneStr = Number(item.milestone).toLocaleString();
    const tooltipText = item.placement
      ? `${milestoneStr} Glark Trophy #${item.placement}`
      : `${milestoneStr} Glark Trophy`;
    circle.dataset.tooltip = tooltipText;
    if (tooltip) {
      circle.addEventListener('mouseenter', () => {
        const rect = circle.getBoundingClientRect();
        tooltip.textContent = tooltipText;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.top = `${rect.top - 10}px`;
        tooltip.style.transform = 'translateX(-50%) translateY(-100%)';
        tooltip.style.display = 'block';
      });
      circle.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });
    }
    if (itemSelectionTarget) {
      circle.classList.add('selectable');
      circle.onclick = () => transferItem(item);
    }
    list.appendChild(circle);
  });
}

function getItemColorClass(milestone) {
  if (milestone >= 1000000000) return 'item-circle-white';
  if (milestone >= 1000000) return 'item-circle-green';
  if (milestone >= 1000) return 'item-circle-blue';
  return 'item-circle-yellow';
}

function computeCircleSize(count) {
  const list = document.querySelector('#itemsBox .items-list');
  const MAX_SIZE = 44;
  const MIN_SIZE = 18;
  const GAP = 4;
  if (count === 0) return MAX_SIZE;
  const w = (list && list.clientWidth > 0) ? list.clientWidth : 248;
  const h = 288; // target height ≈ max-height minus small padding
  for (let size = MAX_SIZE; size >= MIN_SIZE; size -= 2) {
    const perRow = Math.floor((w + GAP) / (size + GAP));
    if (perRow <= 0) continue;
    const rows = Math.ceil(count / perRow);
    if (rows * (size + GAP) <= h) return size;
  }
  // If container is too narrow to compute, fall back to MIN_SIZE.
  return MIN_SIZE;
}

function enterItemSelectionMode(targetPlayer) {
  itemSelectionTarget = targetPlayer;
  document.getElementById('selectionTargetName').textContent = targetPlayer.name;
  document.getElementById('selectionModeBar').classList.remove('hidden');
  refreshItems();
}

function exitItemSelectionMode() {
  itemSelectionTarget = null;
  document.getElementById('selectionModeBar').classList.add('hidden');
  refreshItems();
}

function transferItem(item) {
  const sender = getCurrentPlayer();
  if (!sender || !itemSelectionTarget) return;
  const fee = item.milestone / 2;
  const feeStr = Number(fee).toLocaleString();
  if (sender.glark < fee) {
    showToast(`Not enough Glark to pay the transfer fee of ${feeStr} Glark.`);
    return;
  }
  const msg = document.getElementById('transferConfirmMessage');
  msg.textContent = `This transfer will cost ${feeStr} Glark. Would you like to proceed?`;
  const modal = document.getElementById('transferConfirmModal');
  modal.classList.remove('hidden');

  const yesBtn = document.getElementById('transferConfirmYes');
  const noBtn = document.getElementById('transferConfirmNo');

  function cleanup() {
    modal.classList.add('hidden');
  }

  yesBtn.addEventListener('click', () => {
    cleanup();
    socket.emit('send_item', { fromId: sender.id, itemId: item.id, toId: itemSelectionTarget.id }, response => {
      if (response && !response.success) {
        showToast(response.message);
      } else {
        exitItemSelectionMode();
      }
    });
  }, { once: true });

  noBtn.addEventListener('click', () => {
    cleanup();
  }, { once: true });
}


function openTransfer(targetId) {
  const sender = getCurrentPlayer();
  if (!sender) return;
  transferTargetPlayer = gameState.players.find(p => p.id === targetId);
  if (!transferTargetPlayer) return;
  const targetLabel = transferTargetPlayer.id === sender.id ? 'yourself' : transferTargetPlayer.name;
  elements.transferTarget.textContent = `${sender.name} → ${targetLabel}`;
  elements.transferAmount.value = '';
  // Show "Send Item" button only when sender has items and target is not self.
  const sendItemBtn = document.getElementById('sendItemBtn');
  const hasItems = Array.isArray(sender.items) && sender.items.length > 0;
  const isSelf = transferTargetPlayer.id === sender.id;
  if (sendItemBtn) {
    sendItemBtn.classList.toggle('hidden', !hasItems || isSelf);
  }
  elements.transferModal.classList.remove('hidden');
}

function closeTransfer() {
  transferTargetPlayer = null;
  elements.transferModal.classList.add('hidden');
}

function confirmTransfer() {
  const sender = getCurrentPlayer();
  const amount = parseFloat(elements.transferAmount.value);
  if (!sender || !transferTargetPlayer || !Number.isFinite(amount) || amount <= 0) {
    showToast('Enter a valid positive amount');
    return;
  }
  if (amount > sender.glark) {
    showToast('Not enough Glark to send.');
    return;
  }
  if (sender.glark - amount < 10) {
    showToast('You must keep at least 10 Glark after transferring.');
    return;
  }

  socket.emit('send_glark', { fromId: sender.id, toId: transferTargetPlayer.id, amount }, response => {
    if (response && !response.success) {
      showToast(response.message);
    } else {
      closeTransfer();
    }
  });
}

function setupEvents() {
  showAuth(true);

  elements.authLoginBtn.addEventListener('click', () => {
    const username = elements.authUsername.value.trim();
    const password = elements.authPassword.value;
    socket.emit('login', { username, password }, response => {
      if (response.success) {
        currentPlayerId = response.playerId;
        currentUsername = response.username;
        showAuth(false);
        refreshAll();
      } else {
        showAuth(true, response.message);
      }
    });
  });

  elements.authRegisterBtn.addEventListener('click', () => {
    const username = elements.authUsername.value.trim();
    const password = elements.authPassword.value;
    socket.emit('register', { username, password }, response => {
      if (response.success) {
        currentPlayerId = response.playerId;
        currentUsername = response.username;
        showAuth(false);
        refreshAll();
      } else {
        showAuth(true, response.message);
      }
    });
  });

  elements.txFilter.addEventListener('input', refreshTransactions);
  elements.chatFilter.addEventListener('input', refreshChat);

  elements.sendChatBtn.addEventListener('click', () => {
    const player = getCurrentPlayer();
    const text = elements.chatMessage.value.trim();
    if (!player || !text) return;
    socket.emit('send_chat', { playerId: player.id, room: activeChatRoom, text });
    elements.chatMessage.value = '';
  });

  elements.chatTabs.forEach(tab => tab.addEventListener('click', () => {
    elements.chatTabs.forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    activeChatRoom = Number(tab.dataset.chat);
    refreshChat();
  }));

  elements.cancelTransfer.addEventListener('click', closeTransfer);
  elements.confirmTransfer.addEventListener('click', confirmTransfer);

  document.getElementById('sendItemBtn').addEventListener('click', () => {
    const sender = getCurrentPlayer();
    if (!sender || !Array.isArray(sender.items) || sender.items.length === 0) {
      showToast('You have no items to send.');
      return;
    }
    if (!transferTargetPlayer) return;
    const target = transferTargetPlayer; // capture before closeTransfer() nulls it
    closeTransfer();
    enterItemSelectionMode(target);
  });

  document.getElementById('cancelSelectionBtn').addEventListener('click', exitItemSelectionMode);

  socket.on('state', state => {
    gameState = state;
    if (!currentPlayerId || !gameState.players.some(p => p.id === currentPlayerId)) {
      currentPlayerId = gameState.players[0]?.id || null;
    }
    refreshAll();
  });

  socket.on('connect', () => {
    socket.emit('join', serverState => {
      gameState = serverState;
      currentPlayerId = currentPlayerId || gameState.players[0]?.id || null;
      refreshAll();
    });
  });

  socket.on('disconnect', () => console.warn('Disconnected from server'));

  socket.on('tick_info', ({ nextTickAt: nta }) => {
    nextTickAt = nta;
    updateTickDisplay();
  });

  socket.on('trophy', ({ milestone, placement }) => {
    showTrophyOverlay(milestone, placement);
  });
}

setupEvents();
