const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const rooms = new Map();

function generateRoomCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += charset[Math.floor(Math.random() * charset.length)];
  }
  return code;
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 32) || 'Гость';
}

function addSocketToRoom(socket, room, name) {
  const cleanName = sanitizeName(name);
  room.members.set(socket.id, { name: cleanName, joinedAt: Date.now() });
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.displayName = cleanName;
}

function removeSocketFromRoom(socket) {
  const { roomCode } = socket.data;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.members.delete(socket.id);
  io.to(room.code).emit('user-left', { id: socket.id });
  if (room.members.size === 0) {
    rooms.delete(room.code);
  }
}

io.on('connection', (socket) => {
  socket.data = { roomCode: null, displayName: null };

  socket.on('createRoom', ({ name } = {}, callback = () => {}) => {
    const displayName = sanitizeName(name);
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const room = { code, createdAt: Date.now(), members: new Map() };
    rooms.set(code, room);
    addSocketToRoom(socket, room, displayName);

    callback({ ok: true, code, members: [] });
  });

  socket.on('joinRoom', ({ code, name } = {}, callback = () => {}) => {
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode) {
      callback({ ok: false, error: 'Введите секретный код комнаты.' });
      return;
    }

    const room = rooms.get(normalizedCode);
    if (!room) {
      callback({ ok: false, error: 'Комната не найдена.' });
      return;
    }

    const displayName = sanitizeName(name);
    addSocketToRoom(socket, room, displayName);

    const existingMembers = [];
    room.members.forEach((value, memberId) => {
      if (memberId !== socket.id) {
        existingMembers.push({ id: memberId, name: value.name });
      }
    });

    socket.to(room.code).emit('user-joined', { id: socket.id, name: displayName });
    callback({ ok: true, code: room.code, members: existingMembers });
  });

  socket.on('webrtc-offer', ({ targetId, sdp } = {}) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-offer', {
      from: socket.id,
      sdp,
      name: socket.data.displayName || 'Гость',
    });
  });

  socket.on('webrtc-answer', ({ targetId, sdp } = {}) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-answer', {
      from: socket.id,
      sdp,
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate } = {}) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit('webrtc-ice-candidate', {
      from: socket.id,
      candidate,
    });
  });

  socket.on('relay-message', (payload = {}) => {
    const { roomCode, displayName } = socket.data;
    if (!roomCode) return;
    const text = String(payload.text || '').trim().slice(0, 500);
    if (!text) return;
    const safePayload = {
      id: payload.id || `${socket.id}-${Date.now()}`,
      text,
      timestamp: payload.timestamp || Date.now(),
      senderId: socket.id,
      name: displayName || payload.name || 'Гость',
    };
    socket.to(roomCode).emit('relay-message', safePayload);
  });

  socket.on('disconnect', () => {
    removeSocketFromRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
