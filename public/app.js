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

let currentRoomCode = null;
let displayName = '';
let selfId = null;
let localStream = null;
let micEnabled = false;
let audioContext = null;

const supportsMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

messageInput.disabled = true;
sendButton.disabled = true;
shareCodeBtn.disabled = true;
if (toggleMicBtn && !supportsMedia) {
  toggleMicBtn.disabled = true;
  micStatusLabel.textContent = 'Браузер не поддерживает звук';
}

audioGrid?.classList.add('hidden');

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
  const clean = name || 'Участник';
  peerNames.set(id, clean);
  ensurePeer(id, clean, false);
  refreshAudioLabel(id);
  appendSystem(`${clean} подключился к комнате.`);
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
  const peer = ensurePeer(from, name || peerNames.get(from) || 'Участник', false);
  peerNames.set(from, peer.name);
  await acceptRemoteDescription(peer, sdp);
});

socket.on('webrtc-answer', async ({ from, sdp }) => {
  if (!from || !sdp) return;
  const peer = peers.get(from);
  if (!peer) return;
  await acceptRemoteDescription(peer, sdp);
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
      .catch(() => copyToClipboard(text, shareCodeBtn));
  } else {
    copyToClipboard(text, shareCodeBtn);
  }
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
  updateMicUi();
  appendSystem(`Ты в комнате ${code}. Ожидаем подключения.`);
  prepareLocalAudio().catch(() => {
    appendSystem('Разреши доступ к микрофону, чтобы говорить голосом.');
  });

  members.forEach(({ id, name }) => {
    peerNames.set(id, name || 'Участник');
    ensurePeer(id, name || 'Участник', true);
  });
  updateParticipantCounter();
}

function ensurePeer(peerId, peerName, initiator) {
  let peer = peers.get(peerId);
  if (peer) return peer;

  const polite = !initiator;
  const pc = new RTCPeerConnection(RTC_CONFIGURATION);
  peer = {
    id: peerId,
    name: peerName || 'Участник',
    polite,
    pc,
    channel: null,
    localAudioSender: null,
    outbox: [],
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
  };
  peers.set(peerId, peer);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: peerId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) {
      destroyPeer(peerId);
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      handleRemoteTrack(peerId, stream);
    }
  };

  pc.onnegotiationneeded = async () => {
    await handleNegotiationNeeded(peerId);
  };

  if (initiator) {
    const channel = pc.createDataChannel('chat', { ordered: true });
    wireDataChannel(peerId, channel);
  } else {
    pc.ondatachannel = (event) => {
      wireDataChannel(peerId, event.channel);
    };
  }

  if (localStream) {
    attachLocalAudio(peerId, peer);
  }

  return peer;
}

async function handleNegotiationNeeded(peerId) {
  const peer = peers.get(peerId);
  if (!peer || peer.makingOffer) return;
  try {
    peer.makingOffer = true;
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    socket.emit('webrtc-offer', { targetId: peerId, sdp: peer.pc.localDescription });
  } catch (err) {
    console.error('Negotiation failed', err);
  } finally {
    peer.makingOffer = false;
  }
}

async function acceptRemoteDescription(peer, descriptionLike) {
  const description = descriptionLike.type
    ? descriptionLike
    : new RTCSessionDescription(descriptionLike);
  const offerCollision =
    description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
  peer.ignoreOffer = !peer.polite && offerCollision;
  if (peer.ignoreOffer) {
    console.warn('Offer ignored due to glare');
    return;
  }
  try {
    await peer.pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetId: peer.id, sdp: peer.pc.localDescription });
    }
  } catch (err) {
    console.error('SDP apply failed', err);
  }
}

function wireDataChannel(peerId, channel) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.channel = channel;

  channel.onopen = () => {
    appendSystem(`${peer.name} на связи.`);
    flushPeerQueue(peerId);
    updateParticipantCounter();
  };

  channel.onclose = () => {
    updateParticipantCounter();
  };

  channel.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleIncomingChat(payload, peer.name);
    } catch (err) {
      console.warn('Не удалось разобрать сообщение', err);
    }
  };
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

function flushPeerQueue(peerId) {
  const peer = peers.get(peerId);
  if (!peer || !peer.channel || peer.channel.readyState !== 'open') return;
  while (peer.outbox.length > 0) {
    const payload = peer.outbox.shift();
    try {
      peer.channel.send(JSON.stringify(payload));
    } catch (err) {
      peer.outbox.unshift(payload);
      break;
    }
  }
}

function attachLocalAudio(peerId, peer) {
  if (!localStream) return;
  const [track] = localStream.getAudioTracks();
  if (!track) return;
  if (peer.localAudioSender && peer.localAudioSender.track === track) return;
  try {
    peer.localAudioSender = peer.pc.addTrack(track, localStream);
  } catch (err) {
    console.warn('Не удалось добавить локальный трек', err);
  }
}

async function enableMicrophone() {
  try {
    await prepareLocalAudio();
    micEnabled = true;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    peers.forEach((peer, peerId) => attachLocalAudio(peerId, peer));
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
  return prepareLocalAudio();
}

async function prepareLocalAudio() {
  if (localStream) return localStream;
  if (!supportsMedia) {
    throw new Error('media not supported');
  }
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });
  peers.forEach((peer, peerId) => attachLocalAudio(peerId, peer));
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
  const attemptPlay = () => {
    const promise = card.audio.play();
    if (promise?.catch) {
      promise.catch(() => {});
    }
  };
  if (card.audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
    attemptPlay();
  } else {
    card.audio.onloadeddata = () => {
      card.audio.onloadeddata = null;
      attemptPlay();
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
    try {
      peer.channel.close();
    } catch (err) {
      console.warn('Channel close failed', err);
    }
    peer.channel.onopen = null;
    peer.channel.onclose = null;
    peer.channel.onmessage = null;
  }
  try {
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.ondatachannel = null;
    peer.pc.close();
  } catch (err) {
    console.warn('Peer close failed', err);
  }
  peers.delete(peerId);
  removeAudioCard(peerId);
}

function handleIncomingChat(payload = {}, fallbackName = 'Участник') {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return;
  const id = payload.id || generateMessageId();
  if (!registerMessageId(id)) return;
  const fromSelf = payload.senderId && selfId && payload.senderId === selfId;
  const author = fromSelf ? 'Ты' : payload.name || fallbackName || 'Участник';
  appendMessage({ author, text, type: fromSelf ? 'me' : 'peer', timestamp: payload.timestamp || Date.now() });
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

function ensureAudioReady() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

function playJoinSound() {
  const ctx = getAudioContext();
  if (!ctx) return;
  ensureAudioReady();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  osc.type = 'triangle';
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.45);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioContext = new Ctor();
  return audioContext;
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
