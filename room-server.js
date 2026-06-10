'use strict';

const rooms = {};

function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (rooms[code]);
  return code;
}

function serializeRoom(room) {
  return {
    code: room.code,
    name: room.name,
    master: room.master,
    players: Object.values(room.players).map(p => serializePlayer(p)),
    started: room.started
  };
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, ready: p.ready, master: p.master };
}

function setupRoomEvents(io) {
  io.on('connection', socket => {
    let currentRoom = null;
    let playerData = null;

    socket.on('room:create', (data) => {
      const code = generateCode();
      const room = {
        code, name: data.name || 'Room ' + code,
        master: socket.id, players: {}, started: false, messages: []
      };
      rooms[code] = room;
      playerData = { id: socket.id, name: data.playerName || 'Player 1', ready: false, master: true };
      room.players[socket.id] = playerData;
      currentRoom = room;
      socket.join(code);
      socket.emit('room:created', { room: serializeRoom(room), player: serializePlayer(playerData) });
    });

    socket.on('room:join', (data) => {
      const room = rooms[data.code];
      if (!room) return socket.emit('room:error', { message: 'Room not found' });
      if (room.started) return socket.emit('room:error', { message: 'Game already started' });
      if (Object.keys(room.players).length >= 2) return socket.emit('room:error', { message: 'Room is full' });
      playerData = { id: socket.id, name: data.playerName || 'Player 2', ready: false, master: false };
      room.players[socket.id] = playerData;
      currentRoom = room;
      socket.join(room.code);
      socket.emit('room:joined', { room: serializeRoom(room), player: serializePlayer(playerData) });
      io.to(room.code).emit('room:player:join', { player: serializePlayer(playerData) });
      io.to(room.code).emit('room:state', serializeRoom(room));
    });

    socket.on('room:ready', () => {
      if (!currentRoom || !playerData) return;
      playerData.ready = true;
      currentRoom.players[socket.id] = playerData;
      io.to(currentRoom.code).emit('room:player:ready', { player: serializePlayer(playerData) });
      io.to(currentRoom.code).emit('room:state', serializeRoom(currentRoom));
      const allReady = Object.values(currentRoom.players).length === 2 &&
                       Object.values(currentRoom.players).every(p => p.ready);
      if (allReady) {
        currentRoom.started = true;
        io.to(currentRoom.code).emit('room:game:start', {
          code: currentRoom.code,
          players: Object.values(currentRoom.players).map(p => serializePlayer(p))
        });
      }
    });

    socket.on('room:talk', (data) => {
      if (!currentRoom) return;
      const msg = { player: playerData?.name || 'Unknown', content: data.content || '', time: Date.now() };
      io.to(currentRoom.code).emit('room:talk', msg);
    });

    socket.on('disconnect', () => {
      if (!currentRoom) return;
      delete currentRoom.players[socket.id];
      io.to(currentRoom.code).emit('room:player:leave', { id: socket.id });
      io.to(currentRoom.code).emit('room:state', serializeRoom(currentRoom));
      if (Object.keys(currentRoom.players).length === 0) {
        delete rooms[currentRoom.code];
      } else if (currentRoom.master === socket.id) {
        currentRoom.master = Object.keys(currentRoom.players)[0];
        currentRoom.players[currentRoom.master].master = true;
        io.to(currentRoom.code).emit('room:master', { master: currentRoom.master });
      }
      currentRoom = null; playerData = null;
    });
  });
}

module.exports = { setupRoomEvents, rooms };
