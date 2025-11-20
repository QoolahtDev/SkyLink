const socket = io();

const RTC_CONFIGURATION = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:eu-west.relay.metered.ca:80',
        'turn:eu-west.relay.metered.ca:80?transport=tcp',
        'turn:eu-west.relay.metered.ca:443',
        'turns:eu-west.relay.metered.ca:443?transport=tcp',
      ],
      username: '9dc34ed2820c9b9e6bfb23d5',
      credential: 'McuUffqDox+b+Vk7',
    },
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

const toggleMicBtn = document.getElementById('toggleMicBtn');
const micStatusLabel = document.getElementById('micStatus');
const audioGrid = document.getElementById('audioGrid');

const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const sendButton = messageForm.querySelector('button');

const peers = new Map();
const peerNames = new Map();
const audioCards = new Map();
const seenMessages = new Set();
const joinSound = (() => {
  try {
    const audio = new Audio('audio/join.mp3');
    audio.preload = 'auto';
    audio.volume = 0.45;
    audio.crossOrigin = 'anonymous';
    return audio;
  } catch (err) {
    return null;
  }
})();

let audioContext = null;
let audioUnlockAttempted = false;

let currentRoomCode = null;
let displayName = '';
let selfId = null;
let localStream = null;
let micEnabled = false;

const supportsMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

document.addEventListener(
  'pointerdown',
  () => {
    ensureAudioReady();
  },
  { once: true },
);
document.addEventListener(
  'keydown',
  () => {
    ensureAudioReady();
  },
  { once: true },
);

messageInput.disabled = true;
sendButton.disabled = true;
shareCodeBtn.disabled = true;
if (toggleMicBtn && !supportsMedia) {
  toggleMicBtn.disabled = true;
  micStatusLabel.textContent = 'Браузер не поддерживает звук';
}

audioGrid?.classList.add('hidden');

socket.on('connect', () => {
  selfId = socket.id;
});

socket.on('disconnect', () => {
  appendSystem('Соединение с сервером потеряно.');
  messageInput.disabled = true;
  sendButton.disabled = true;
});

socket.on('user-joined', ({ id, name }) => {
  if (!currentRoomCode || !id) return;
  const cleanName = name || 'Участник';
  peerNames.set(id, cleanName);
  ensurePeer(id, cleanName, false);
  refreshAudioLabel(id);
  appendSystem(`${cleanName} подключился к комнате.`);
  playJoinSound();
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

socket.on('relay-message', (payload = {}) => {
  handleIncomingChat(payload);
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
    id: generateMessageId(),
    text,
    name: displayName,
    senderId: selfId,
    timestamp: Date.now(),
  };
  registerMessageId(payload.id);
  appendMessage({ author: 'Ты', text, type: 'me', timestamp: payload.timestamp });
  messageInput.value = '';
  broadcastPayload(payload);
  socket.emit('relay-message', payload);
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

toggleMicBtn?.addEventListener('click', async () => {
  if (!supportsMedia) {
    appendSystem('Этот браузер не поддерживает голосовой канал.');
    return;
  }
  if (micEnabled) {
    disableMicrophone();
  } else {
    await enableMicrophone();
  }
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
  updateMicUi();
  ensureAudioReady();

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
    outbox: [],
    audioTransceiver: null,
    makingOffer: false,
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

  pc.ontrack = (event) => {
    if (!event.streams?.length) return;
    handleRemoteTrack(peerId, event.streams[0]);
  };

  try {
    peer.audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  } catch (err) {
    console.warn('Не удалось создать аудио-трансивер', err);
    peer.audioTransceiver = null;
  }

  if (initiator) {
    const channel = pc.createDataChannel('chat', { ordered: true });
    wireDataChannel(peerId, channel);
  } else {
    pc.ondatachannel = (event) => {
      wireDataChannel(peerId, event.channel);
    };
  }

  if (micEnabled && localStream) {
    attachAudioToPeer(peerId, peer);
  }

  return peer;
}

function wireDataChannel(peerId, channel) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.channel = channel;

  channel.onopen = () => {
    peer.connected = true;
    flushPeerQueue(peerId);
    appendSystem(`${peer.name} на связи.`);
    updateParticipantCounter();
  };

  channel.onclose = () => {
    peer.connected = false;
    updateParticipantCounter();
  };

  channel.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.text) {
        handleIncomingChat(
          {
            ...payload,
            name: payload.name || peer.name || 'Участник',
          },
          peer.name || 'Участник',
        );
      }
    } catch (err) {
      console.warn('Не удалось разобрать сообщение', err);
    }
  };
}

function flushPeerQueue(peerId) {
  const peer = peers.get(peerId);
  if (!peer || !peer.channel || peer.channel.readyState !== 'open') return;
  while (peer.outbox.length > 0) {
    const payload = peer.outbox.shift();
    try {
      peer.channel.send(JSON.stringify(payload));
    } catch (err) {
      console.warn('Не удалось отправить сообщение', err);
      break;
    }
  }
}

function broadcastPayload(payload) {
  peers.forEach((peer) => {
    if (peer.channel && peer.channel.readyState === 'open') {
      try {
        peer.channel.send(JSON.stringify(payload));
      } catch (err) {
        peer.outbox.push(payload);
      }
    } else {
      peer.outbox.push(payload);
    }
  });
}

function createAndSendOffer(peerId, peer) {
  if (!peer || peer.makingOffer) return Promise.resolve();
  peer.makingOffer = true;
  return peer.pc
    .createOffer()
    .then((offer) => peer.pc.setLocalDescription(offer))
    .then(() => {
      socket.emit('webrtc-offer', { targetId: peerId, sdp: peer.pc.localDescription });
    })
    .catch((err) => {
      console.error('Offer creation failed', err);
    })
    .finally(() => {
      peer.makingOffer = false;
    });
}

function attachAudioToPeer(peerId, peer) {
  if (!peer || !peer.audioTransceiver) return;
  if (!localStream || !micEnabled) return;
  const [track] = localStream.getAudioTracks();
  if (!track) return;
  try {
    const sender = peer.audioTransceiver.sender;
    if (sender.track === track) return;
    sender.replaceTrack(track);
    createAndSendOffer(peerId, peer);
  } catch (err) {
    console.warn('Не удалось передать трек', err);
  }
}

async function enableMicrophone() {
  try {
    await ensureLocalStream();
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    micEnabled = true;
    peers.forEach((peer, peerId) => {
      attachAudioToPeer(peerId, peer);
    });
    appendSystem('Микрофон включен.');
    updateMicUi();
  } catch (err) {
    appendSystem('Не удалось получить доступ к микрофону.');
    console.error(err);
  }
}

function disableMicrophone() {
  micEnabled = false;
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
  }
  appendSystem('Микрофон выключен.');
  updateMicUi();
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  if (!supportsMedia) {
    throw new Error('media not supported');
  }
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });
  return localStream;
}

function handleRemoteTrack(peerId, stream) {
  let card = audioCards.get(peerId);
  if (!card) {
    card = createAudioCard(peerId);
    audioCards.set(peerId, card);
    audioGrid.classList.remove('hidden');
    audioGrid.appendChild(card.wrapper);
  }
  card.audio.srcObject = stream;
  ensureAudioReady();
  const playAudio = () => {
    const promise = card.audio.play();
    if (promise && typeof promise.then === 'function') {
      promise.catch(() => {});
    }
  };
  if (card.audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
    playAudio();
  } else {
    card.audio.onloadeddata = () => {
      card.audio.onloadeddata = null;
      playAudio();
    };
  }
}

function createAudioCard(peerId) {
  const wrapper = document.createElement('article');
  wrapper.className = 'audio-card';
  const title = document.createElement('strong');
  title.textContent = peerNames.get(peerId) || 'Участник';
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.controls = true;
  audio.playsInline = true;
  audio.dataset.peer = peerId;
  wrapper.append(title, audio);
  return { wrapper, audio, title };
}

function refreshAudioLabel(peerId) {
  const card = audioCards.get(peerId);
  if (card) {
    card.title.textContent = peerNames.get(peerId) || 'Участник';
  }
}

function removeAudioCard(peerId) {
  const card = audioCards.get(peerId);
  if (!card) return;
  card.audio.srcObject = null;
  card.wrapper.remove();
  audioCards.delete(peerId);
  if (audioCards.size === 0) {
    audioGrid.classList.add('hidden');
  }
}

function destroyPeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  if (peer.channel) {
    peer.channel.onclose = null;
    peer.channel.onmessage = null;
    if (peer.channel.readyState !== 'closed') {
      try {
        peer.channel.close();
      } catch (err) {
        console.warn('Channel close failed', err);
      }
    }
  }
  peer.pc.onicecandidate = null;
  peer.pc.ondatachannel = null;
  peer.pc.oniceconnectionstatechange = null;
  peer.pc.ontrack = null;
  try {
    peer.pc.close();
  } catch (err) {
    console.warn('Peer close failed', err);
  }
  peers.delete(peerId);
  removeAudioCard(peerId);
}

function handleIncomingChat(payload = {}, fallbackName = 'Участник') {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const normalizedText = text.trim();
  if (!normalizedText) return;
  const id = payload.id || generateMessageId();
  if (!registerMessageId(id)) return;
  const fromSelf = payload.senderId && selfId && payload.senderId === selfId;
  const author = fromSelf ? 'Ты' : payload.name || fallbackName || 'Участник';
  appendMessage({
    author,
    text: normalizedText,
    type: fromSelf ? 'me' : 'peer',
    timestamp: payload.timestamp || Date.now(),
  });
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

function updateMicUi() {
  if (!toggleMicBtn) return;
  if (!supportsMedia) return;
  if (micEnabled) {
    toggleMicBtn.textContent = 'Выключить микрофон';
    toggleMicBtn.classList.add('active');
    micStatusLabel.textContent = 'Микрофон включен';
  } else {
    toggleMicBtn.textContent = 'Включить микрофон';
    toggleMicBtn.classList.remove('active');
    micStatusLabel.textContent = 'Микрофон выключен';
  }
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
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  seenMessages.clear();
  socket.disconnect();
  window.location.reload();
}

function generateMessageId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `${selfId || 'self'}-${Date.now()}-${random}`;
}

function registerMessageId(id) {
  if (!id) return false;
  if (seenMessages.has(id)) return false;
  seenMessages.add(id);
  if (seenMessages.size > 2000) {
    seenMessages.clear();
  }
  return true;
}

function ensureAudioReady() {
  const ctx = getAudioContext();
  if (!ctx) return;
  audioUnlockAttempted = true;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioContext = new Ctor();
  return audioContext;
}

function playJoinSound() {
  if (!joinSound) return;
  ensureAudioReady();
  try {
    joinSound.currentTime = 0;
    const promise = joinSound.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch (err) {
    console.warn('Join sound playback failed', err);
  }
}
