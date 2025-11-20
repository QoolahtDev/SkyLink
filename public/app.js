const socket = io();

const RTC_CONFIGURATION = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const createRoomForm = document.getElementById('createRoomForm');
const createNameInput = document.getElementById('createName');
const roomCodeBox = document.getElementById('roomCodeBox');
const roomCodeValue = document.getElementById('roomCodeValue');
const copyCodeBtn = document.getElementById('copyCodeBtn');

const joinRoomForm = document.getElementById('joinRoomForm');
const joinNameInput = document.getElementById('joinName');
const joinCodeInput = document.getElementById('joinCode');

const lobbyView = document.getElementById('lobbyView');
const roomView = document.getElementById('roomView');
const activeRoomCode = document.getElementById('activeRoomCode');
const selfDisplayName = document.getElementById('selfDisplayName');
const participantCounter = document.getElementById('participantCounter');
const shareCodeBtn = document.getElementById('shareCodeBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');

const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const sendButton = messageForm.querySelector('button');

const peers = new Map(); // peerId -> { pc, channel, name, connected }
const peerNames = new Map();
let currentRoomCode = null;
let displayName = '';
let selfId = null;

messageInput.disabled = true;
sendButton.disabled = true;
shareCodeBtn.disabled = true;

socket.on('connect', () => {
  selfId = socket.id;
});

socket.on('disconnect', () => {
  appendSystem('Соединение с сервером потеряно.');
});

socket.on('user-joined', ({ id, name }) => {
  if (!currentRoomCode || !id) return;
  const cleanName = name || 'Участник';
  peerNames.set(id, cleanName);
  appendSystem(`${cleanName} подключился к комнате.`);
  updateParticipantCounter();
});

socket.on('user-left', ({ id }) => {
  if (!id) return;
  const label = peerNames.get(id) || 'Участник';
  appendSystem(`${label} отключился.`);
  peerNames.delete(id);
  destroyPeer(id);
  updateParticipantCounter();
});

socket.on('webrtc-offer', async ({ from, sdp, name }) => {
  if (!from || !sdp) return;
  const peerName = name || peerNames.get(from) || 'Участник';
  peerNames.set(from, peerName);
  const peer = ensurePeer(from, peerName, false);
  try {
    await peer.pc.setRemoteDescription(sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { targetId: from, sdp: peer.pc.localDescription });
  } catch (err) {
    console.error('Offer handling failed', err);
  }
});

socket.on('webrtc-answer', async ({ from, sdp }) => {
  if (!from || !sdp) return;
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription(sdp);
  } catch (err) {
    console.error('Answer handling failed', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
  if (!from || !candidate) return;
  const peer = peers.get(from) || ensurePeer(from, peerNames.get(from) || 'Участник', false);
  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    console.error('ICE candidate failed', err);
  }
});

createRoomForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (currentRoomCode) return;
  const name = createNameInput.value.trim();
  if (!name) {
    createNameInput.focus();
    return;
  }
  setFormDisabled(createRoomForm, true);
  socket.emit('createRoom', { name }, (response = {}) => {
    setFormDisabled(createRoomForm, false);
    if (!response.ok) {
      alert(response.error || 'Не удалось создать комнату.');
      return;
    }
    displayName = name;
    handleRoomEntered(response);
    revealRoomCode(response.code);
    appendSystem('Комната создана. Поделись кодом с друзьями.');
  });
});

joinRoomForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (currentRoomCode) return;
  const name = joinNameInput.value.trim();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!name || !code) {
    joinNameInput.focus();
    return;
  }
  setFormDisabled(joinRoomForm, true);
  socket.emit('joinRoom', { name, code }, (response = {}) => {
    setFormDisabled(joinRoomForm, false);
    if (!response.ok) {
      alert(response.error || 'Ошибка подключения к комнате.');
      return;
    }
    displayName = name;
    handleRoomEntered(response);
  });
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!currentRoomCode) return;
  const text = messageInput.value.trim();
  if (!text) return;
  const payload = {
    text,
    name: displayName,
    senderId: selfId,
    timestamp: Date.now(),
  };
  appendMessage({ author: 'Ты', text, type: 'me', timestamp: payload.timestamp });
  messageInput.value = '';
  broadcastPayload(payload);
});

copyCodeBtn?.addEventListener('click', () => {
  if (!roomCodeValue.textContent) return;
  copyToClipboard(roomCodeValue.textContent, copyCodeBtn);
});

shareCodeBtn?.addEventListener('click', () => {
  if (!currentRoomCode) return;
  const text = `Присоединяйся к моей комнате SkyLink: ${currentRoomCode}`;
  if (navigator.share) {
    navigator
      .share({ title: 'SkyLink комната', text })
      .catch(() => copyToClipboard(text));
  } else {
    copyToClipboard(text, shareCodeBtn);
  }
});

leaveRoomBtn?.addEventListener('click', () => {
  cleanupAndReload();
});

window.addEventListener('beforeunload', () => {
  socket.disconnect();
});

function handleRoomEntered({ code, members = [] }) {
  currentRoomCode = code;
  activeRoomCode.textContent = code;
  selfDisplayName.textContent = displayName;
  lobbyView.classList.add('hidden');
  roomView.classList.remove('hidden');
  shareCodeBtn.disabled = false;
  messageInput.disabled = false;
  sendButton.disabled = false;
  messageInput.focus();
  appendSystem(`Ты в комнате ${code}. Ожидаем подключения.`);

  members.forEach(({ id, name }) => {
    peerNames.set(id, name || 'Участник');
    initiatePeerConnection(id, name || 'Участник');
  });
  updateParticipantCounter();
}

function initiatePeerConnection(peerId, peerName) {
  const peer = ensurePeer(peerId, peerName, true);
  peerNames.set(peerId, peer.name);
  createAndSendOffer(peerId, peer).catch((err) => console.error('Offer failed', err));
}

async function createAndSendOffer(peerId, peer) {
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { targetId: peerId, sdp: peer.pc.localDescription });
}

function ensurePeer(peerId, peerName, initiator) {
  const existing = peers.get(peerId);
  if (existing) return existing;
  const pc = new RTCPeerConnection(RTC_CONFIGURATION);
  const peer = {
    id: peerId,
    name: peerName || 'Участник',
    pc,
    channel: null,
    connected: false,
  };
  peers.set(peerId, peer);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: peerId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
      destroyPeer(peerId);
    }
  };

  if (initiator) {
    const channel = pc.createDataChannel('chat', { ordered: true });
    wireDataChannel(peerId, channel);
  } else {
    pc.ondatachannel = (event) => {
      wireDataChannel(peerId, event.channel);
    };
  }

  return peer;
}

function wireDataChannel(peerId, channel) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.channel = channel;

  channel.onopen = () => {
    if (!peer.connected) {
      peer.connected = true;
      appendSystem(`${peer.name} на связи.`);
    }
    updateParticipantCounter();
  };

  channel.onclose = () => {
    peer.connected = false;
    destroyPeer(peerId);
    updateParticipantCounter();
  };

  channel.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.text && payload?.name) {
        appendMessage({
          author: payload.name,
          text: payload.text,
          type: 'peer',
          timestamp: payload.timestamp || Date.now(),
        });
      }
    } catch (err) {
      console.warn('Не удалось разобрать сообщение', err);
    }
  };
}

function broadcastPayload(payload) {
  peers.forEach((peer) => {
    if (peer.channel && peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify(payload));
    }
  });
}

function destroyPeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  if (peer.channel) {
    peer.channel.onclose = null;
    peer.channel.onmessage = null;
    if (peer.channel.readyState !== 'closed') {
      peer.channel.close();
    }
  }
  peer.pc.onicecandidate = null;
  peer.pc.ondatachannel = null;
  peer.pc.oniceconnectionstatechange = null;
  peer.pc.close();
  peers.delete(peerId);
}

function appendMessage({ author, text, type = 'peer', timestamp = Date.now() }) {
  const item = document.createElement('li');
  item.className = `message ${type}`;

  if (type === 'system') {
    item.textContent = text;
  } else {
    const header = document.createElement('div');
    header.className = 'msg-author';
    header.textContent = author;

    const body = document.createElement('p');
    body.textContent = text;

    const meta = document.createElement('small');
    meta.textContent = formatTime(timestamp);

    item.append(header, body, meta);
  }

  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendSystem(text) {
  appendMessage({ text, type: 'system' });
}

function updateParticipantCounter() {
  if (!currentRoomCode) {
    participantCounter.textContent = 'Подключись, чтобы увидеть участников';
    return;
  }
  const total = peers.size + 1;
  participantCounter.textContent = total === 1 ? 'Ты один в комнате' : `Участников: ${total}`;
}

function revealRoomCode(code) {
  roomCodeValue.textContent = code;
  roomCodeBox.classList.remove('hidden');
}

function copyToClipboard(text, button) {
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
  flashButton(button, 'Готово');
}

function flashButton(button, message) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = message;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1600);
}

function setFormDisabled(form, disabled) {
  const fields = form.querySelectorAll('input, button');
  fields.forEach((field) => {
    field.disabled = disabled;
  });
}

function formatTime(timestamp) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch (err) {
    return '';
  }
}

function cleanupAndReload() {
  Array.from(peers.keys()).forEach((id) => destroyPeer(id));
  socket.disconnect();
  window.location.reload();
}
