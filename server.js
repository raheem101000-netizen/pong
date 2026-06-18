const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pong-multiplayer.html'));
});
app.get('/health', (req, res) => res.send('Pong Multiplayer Server running'));

const TICK_RATE      = 60;
const POINTS_TO_WIN  = 10;
const TOTAL_MATCHES  = 1;
const MATCH_STAKE    = 10;
const W = 400, H = 660;
const BALL_R         = Math.round(Math.min(W,H) * 0.018);
const PADDLE_LONG    = Math.round(W * 0.28);
const PADDLE_SHORT   = Math.round(H * 0.018);
const BALL_SPEED     = Math.min(W,H) * 0.022;
const SPEED_MAX      = Math.min(W,H) * 0.040;
const TIER_LABELS = ['EASY','EASY+','MEDIUM','MEDIUM+','HARD','HARD+','MAX'];

function getMatchTier(m) { return Math.min(Math.floor((m - 1) / 3), 6); }

function initMatchState(room) {
  if (!room.seriesMatch) room.seriesMatch = 1;
  if (!room.p1Wins)      room.p1Wins = 0;
  if (!room.p2Wins)      room.p2Wins = 0;
  if (!room.p1Balance)   room.p1Balance = 0;
  if (!room.p2Balance)   room.p2Balance = 0;
  if (!room.results)     room.results = [];
  room.state = {
    ball: { x: W/2, y: H/2, vx: 0, vy: 0 },
    p1:   { x: W/2 - PADDLE_LONG/2, y: H - PADDLE_SHORT - Math.round(H*0.04), score: 0 },
    p2:   { x: W/2 - PADDLE_LONG/2, y: Math.round(H*0.04), score: 0 },
    tier: getMatchTier(room.seriesMatch), delay: 180, active: false,
  };
}

function resetBall(state, towardsP1) {
  state.ball.x = W/2; state.ball.y = H/2;
  state.ball.vx = 0; state.ball.vy = 0;
  state.delay = 90; state._pendingDir = towardsP1;
}

function tickBall(room) {
  const s = room.state, b = s.ball;
  if (s.delay > 0) {
    s.delay--;
    if (s.delay === 0) {
      b.vx = BALL_SPEED * (Math.random() > 0.5 ? 1 : -1);
      b.vy = BALL_SPEED * (s._pendingDir !== false ? 1 : -1);
    }
    return null;
  }
  b.x += b.vx; b.y += b.vy;
  if (b.x - BALL_R < 0)  { b.x = BALL_R;     b.vx =  Math.abs(b.vx); }
  if (b.x + BALL_R > W)  { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
  function hitPaddle(p, isP1) {
    const prevY = b.y - b.vy;
    const hitX = b.x+BALL_R>p.x && b.x-BALL_R<p.x+PADDLE_LONG;
    const hitYNow = b.y+BALL_R>p.y && b.y-BALL_R<p.y+PADDLE_SHORT;
    const paddleY = isP1 ? p.y : p.y+PADDLE_SHORT;
    const crossed = isP1
      ? (prevY-BALL_R > paddleY && b.y-BALL_R <= paddleY)
      : (prevY+BALL_R < paddleY && b.y+BALL_R >= paddleY);

    if (hitX && (hitYNow || crossed)) {
      const rel = (b.x-(p.x+PADDLE_LONG/2))/(PADDLE_LONG/2);
      const clampedRel = Math.max(-1, Math.min(1, rel));
      const spd = Math.min(Math.hypot(b.vx,b.vy)+0.3, SPEED_MAX);
      b.vx = Math.sin(clampedRel*(Math.PI/4))*spd;
      b.vy = Math.cos(clampedRel*(Math.PI/4))*spd*(isP1?-1:1);
      b.y = isP1 ? p.y-BALL_R-1 : p.y+PADDLE_SHORT+BALL_R+1;
    }
  }
  hitPaddle(s.p1, true); hitPaddle(s.p2, false);
  if (b.y > H+20) { s.p2.score++; resetBall(s, false); return checkScore(room); }
  if (b.y < -20)  { s.p1.score++; resetBall(s, true);  return checkScore(room); }
  return null;
}

function checkScore(room) {
  if (room.state.p1.score >= POINTS_TO_WIN) return 'p1';
  if (room.state.p2.score >= POINTS_TO_WIN) return 'p2';
  return null;
}

function startGameLoop(room) {
  if (room.interval) clearInterval(room.interval);
  room.phase = 'playing';
  room.interval = setInterval(() => {
    if (!room.state) return;
    const winner = tickBall(room);
    io.to(room.code).emit('state', { ball: room.state.ball, p1: room.state.p1, p2: room.state.p2, delay: room.state.delay });
    if (winner) { clearInterval(room.interval); room.interval = null; endMatch(room, winner); }
  }, 1000 / TICK_RATE);
}

function endMatch(room, winner) {
  room.phase = 'matchEnd';
  const p1won = winner === 'p1';
  io.to(room.code).emit('matchEnd', {
    winner,
    p1Score: room.state.p1.score,
    p2Score: room.state.p2.score,
    seriesOver: true,
  });
}

function startNextMatch(room) {
  if (room.seriesMatch >= TOTAL_MATCHES) { endSeries(room); return; }
  room.seriesMatch++; room.phase = 'countdown'; initMatchState(room);
  let count = 3;
  io.to(room.code).emit('countdown', { count });
  const t = setInterval(() => {
    count--;
    if (count > 0) io.to(room.code).emit('countdown', { count });
    else { clearInterval(t); startGameLoop(room); }
  }, 1000);
}

function endSeries(room) {
  room.phase = 'seriesEnd';
  io.to(room.code).emit('seriesEnd', { p1Wins: room.p1Wins, p2Wins: room.p2Wins, p1Balance: room.p1Balance, p2Balance: room.p2Balance, results: room.results });
}

const { setupRoomEvents, rooms } = require('./room-server');
setupRoomEvents(io);

io.on('connection', (socket) => {
  console.log('connect:', socket.id);
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', { msg: 'Room not found' }); return; }

    socket.join(code);
    socket.roomCode = code;

    if (!room.gameJoined) room.gameJoined = [];

    // Prevent same socket joining twice
    if (room.gameJoined.find(p => p.id === socket.id)) return;

    room.gameJoined.push({ id: socket.id, name: name || 'Player' });

    // First to join = p1 (bottom paddle), second = p2 (top paddle)
    const myIndex = room.gameJoined.length - 1;
    const myRole = myIndex === 0 ? 'p1' : 'p2';
    const paddlePos = myRole === 'p1' ? 'BOTTOM' : 'TOP';

    socket.emit('roomJoined', {
      code,
      role: myRole,
      myName: name || 'Player',
      paddlePos
    });

    if (room.gameJoined.length === 2) {
      const p1 = room.gameJoined[0];
      const p2 = room.gameJoined[1];

      // Tell each player their opponent's name
      io.to(p1.id).emit('opponentName', { name: p2.name });
      io.to(p2.id).emit('opponentName', { name: p1.name });

      initMatchState(room);
      let count = 3;
      io.to(code).emit('countdown', { count });
      const t = setInterval(() => {
        count--;
        if (count > 0) io.to(code).emit('countdown', { count });
        else { clearInterval(t); startGameLoop(room); }
      }, 1000);
    }
  });
  socket.on('paddleMove', ({ x }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || !room.state || !room.gameJoined) return;
    const idx = room.gameJoined.findIndex(p => p.id === socket.id);
    if (idx === 0) room.state.p1.x = Math.max(0, Math.min(W - PADDLE_LONG, x));
    if (idx === 1) room.state.p2.x = Math.max(0, Math.min(W - PADDLE_LONG, x));
  });
  socket.on('nextMatch', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (!room.nextMatchReady) room.nextMatchReady = new Set();
    room.nextMatchReady.add(socket.id);
    const playerIds = Object.keys(room.players);
    if (room.nextMatchReady.size >= playerIds.length) {
      room.nextMatchReady.clear();
      startNextMatch(room);
    } else {
      socket.emit('waitingForOpponent');
    }
  });
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    if (rooms[code].interval) clearInterval(rooms[code].interval);
    io.to(code).emit('opponentLeft');
    delete rooms[code];
  });
});

app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Pong server on port ${PORT}`));
