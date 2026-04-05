const socket = io();
let gameState = { players: [], transactions: [], chatRooms: {1: [], 2: [], 3: []} };
let currentPlayerId = null;
let currentUsername = null;
let activeChatRoom = 1;
let transferTargetPlayer = null;

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

const elements = {
  authContainer: document.getElementById('authContainer'),
  gameContainer: document.getElementById('gameContainer'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authLoginBtn: document.getElementById('authLoginBtn'),
  authRegisterBtn: document.getElementById('authRegisterBtn'),
  authMessage: document.getElementById('authMessage'),
  flarkValue: document.getElementById('flarkValue'),
  potentialValue: document.getElementById('potentialValue'),
  multiplierValue: document.getElementById('multiplierValue'),
  potentialBlock: document.getElementById('potentialBlock'),
  convertPotentialBtn: document.getElementById('convertPotentialBtn'),
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

function calculateMultiplier(potential) {
  return 1 + Math.floor(potential / 5) * 0.1;
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
    elements.flarkValue.textContent = '0';
    elements.potentialValue.textContent = '0';
    elements.multiplierValue.textContent = 'x1';
    return;
  }
  elements.flarkValue.textContent = player.flark.toFixed(1);
  elements.potentialValue.textContent = player.potential.toFixed(1);
  const mult = typeof player.multiplier === 'number' ? player.multiplier : 1;
  elements.multiplierValue.textContent = `x${mult.toFixed(2)}`;
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

    if (fromName && toName && !Number.isNaN(amount)) {
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
      p.appendChild(document.createTextNode(` ${amount.toFixed(1)} Glark (to Potential)`));
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
}

function openTransfer(targetId) {
  const sender = getCurrentPlayer();
  if (!sender) return;
  transferTargetPlayer = gameState.players.find(p => p.id === targetId);
  if (!transferTargetPlayer) return;
  const targetLabel = transferTargetPlayer.id === sender.id ? 'yourself' : transferTargetPlayer.name;
  elements.transferTarget.textContent = `${sender.name} → ${targetLabel}`;
  elements.transferAmount.value = '';
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
  if (amount > sender.flark) {
    showToast('Not enough Glark to send');
    return;
  }
  if (sender.flark - amount < 10) {
    showToast('You must keep at least 10 Glark');
    return;
  }

  socket.emit('send_potential', { fromId: sender.id, toId: transferTargetPlayer.id, amount });
  closeTransfer();
}

function convertPotential() {
  const player = getCurrentPlayer();
  if (!player || player.potential <= 0) return;
  socket.emit('convert_potential', { playerId: player.id });
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

  elements.potentialBlock.addEventListener('click', () => openTransfer(currentPlayerId));
  elements.convertPotentialBtn.addEventListener('click', e => {
    e.stopPropagation(); // prevent click bubbling to potentialBlock which opens the transfer modal
    convertPotential();
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
}

setupEvents();
