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
    id: room.code,
    code: room.code,
    name: room.name,
    open: room.open,
    master: room.master,
    players: Object.values(room.players).map(p => serializePlayer(p)),
    started: room.started
  };
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, ready: p.ready, master: p.master, color: p.color };
}

function broadcastRoomList(io) {
  const list = Object.values(rooms)
    .filter(r => !r.started)
    .map(r => ({
      id: r.code,
      name: r.name,
      open: r.open,
      players: Object.keys(r.players).length
    }));
  io.emit('room:list', { rooms: list });
}

function setupRoomEvents(io) {
  io.on('connection', socket => {
    let currentRoom = null;
    let playerData = null;

    // Send room list on request
    socket.on('room:list', () => {
      const list = Object.values(rooms)
        .filter(r => !r.started)
        .map(r => ({
          id: r.code,
          name: r.name,
          open: r.open,
          players: Object.keys(r.players).length
        }));
      socket.emit('room:list', { rooms: list });
    });

    // Create room
    socket.on('room:create', (data) => {
      const code = generateCode();
      const room = {
        code,
        name: data.name || 'Room ' + code,
        open: data.open !== false,
        master: socket.id,
        players: {},
        started: false,
        messages: []
      };
      rooms[code] = room;
      playerData = {
        id: socket.id,
        name: data.playerName || data.player?.name || 'Player 1',
        color: data.player?.color || '#b450ff',
        ready: false,
        master: true
      };
      room.players[socket.id] = playerData;
      currentRoom = room;
      socket.join(code);
      socket.emit('room:created', { room: serializeRoom(room), player: serializePlayer(playerData) });
      broadcastRoomList(io);
    });

    // Join room by code or id
    socket.on('room:join', (data) => {
      const code = data.code || data.room;
      const room = rooms[code];
      if (!room) { socket.emit('room:error', { message: 'Room not found' }); return; }
      if (room.started) { socket.emit('room:error', { message: 'Game already started' }); return; }
      if (Object.keys(room.players).length >= 2) { socket.emit('room:error', { message: 'Room is full' }); return; }

      playerData = {
        id: socket.id,
        name: data.playerName || data.player?.name || 'Player 2',
        color: data.player?.color || '#4488FF',
        ready: false,
        master: false
      };
      room.players[socket.id] = playerData;
      currentRoom = room;
      socket.join(code);
      socket.emit('room:joined', { room: serializeRoom(room), player: serializePlayer(playerData) });
      io.to(code).emit('room:player:join', { player: serializePlayer(playerData) });
      io.to(code).emit('room:state', serializeRoom(room));
      broadcastRoomList(io);
    });

    // Ready — guest clicks Ready, host clicks Start Game
    socket.on('room:ready', () => {
      if (!currentRoom || !playerData) return;
      playerData.ready = true;
      currentRoom.players[socket.id] = playerData;
      io.to(currentRoom.code).emit('room:player:ready', { player: serializePlayer(playerData) });
      io.to(currentRoom.code).emit('room:state', serializeRoom(currentRoom));
      const players = Object.values(currentRoom.players);
      const allReady = players.length === 2 && players.every(p => p.ready);
      if (allReady) {
        currentRoom.started = true;
        broadcastRoomList(io);
        io.to(currentRoom.code).emit('room:game:start', {
          code: currentRoom.code,
          players: players.map(p => serializePlayer(p))
        });
      }
    });

    socket.on('room:launch', () => {
      if (!currentRoom || currentRoom.master !== socket.id) return;
      const players = Object.values(currentRoom.players);
      if (players.length < 2) { socket.emit('room:error', { message: 'Need 2 players' }); return; }
      const guestReady = players.filter(p => !p.master).every(p => p.ready);
      if (!guestReady) { socket.emit('room:error', { message: 'Waiting for opponent to ready up' }); return; }
      // Mark host as ready and start
      playerData.ready = true;
      currentRoom.players[socket.id] = playerData;
      currentRoom.started = true;
      broadcastRoomList(io);
      io.to(currentRoom.code).emit('room:game:start', {
        code: currentRoom.code,
        players: players.map(p => serializePlayer(p))
      });
    });

    // Chat
    socket.on('room:talk', (data) => {
      if (!currentRoom) return;
      io.to(currentRoom.code).emit('room:talk', {
        player: playerData?.name || 'Unknown',
        content: data.content || ''
      });
    });

    // Leave
    socket.on('room:leave', () => leaveRoom());

    // Disconnect
    socket.on('disconnect', (reason) => {
      if (!currentRoom) return;
      // Give mobile users 30 seconds to reconnect before removing them
      const roomCode = currentRoom.code;
      const playerId = socket.id;
      setTimeout(() => {
        const room = rooms[roomCode];
        if (!room) return;
        // If player hasn't reconnected, remove them
        if (room.players[playerId]) {
          const savedRoom = currentRoom;
          leaveRoom();
        }
      }, 30000);
    });

    function leaveRoom() {
      if (!currentRoom) return;
      const room = currentRoom;
      delete room.players[socket.id];
      socket.leave(room.code);
      io.to(room.code).emit('room:player:leave', { id: socket.id });

      if (Object.keys(room.players).length === 0) {
        delete rooms[room.code];
        broadcastRoomList(io);
      } else if (room.master === socket.id) {
        room.master = Object.keys(room.players)[0];
        room.players[room.master].master = true;
        io.to(room.code).emit('room:master', { master: room.master });
      }
      io.to(room.code).emit('room:state', serializeRoom(room));
      broadcastRoomList(io);
      currentRoom = null;
      playerData = null;
    }
  });
}

module.exports = { setupRoomEvents, rooms };
