const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (req, res) => res.send('Pong Multiplayer Server running'));

const TICK_RATE      = 60;
const POINTS_TO_WIN  = 3;
const TOTAL_MATCHES  = 20;
const MATCH_STAKE    = 10;
const W = 400, H = 660;
const BALL_R         = Math.round(Math.min(W,H) * 0.018);
const PADDLE_LONG    = Math.round(W * 0.28);
const PADDLE_SHORT   = Math.round(H * 0.018);
const BALL_SPEED     = Math.min(W,H) * 0.022;
const SPEED_MAX      = Math.min(W,H) * 0.040;
const TIER_LABELS = ['EASY','EASY+','MEDIUM','MEDIUM+','HARD','HARD+','MAX'];

const rooms = {};

function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (rooms[code]);
  return code;
}

function getMatchTier(m) { return Math.min(Math.floor((m - 1) / 3), 6); }

function createRoom(code) {
  return {
    code, players: [], state: null, interval: null,
    seriesMatch: 1, p1Wins: 0, p2Wins: 0,
    p1Balance: 0, p2Balance: 0, results: [], phase: 'waiting',
  };
}

function initMatchState(room) {
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
    if (b.x+BALL_R>p.x && b.x-BALL_R<p.x+PADDLE_LONG && b.y+BALL_R>p.y && b.y-BALL_R<p.y+PADDLE_SHORT) {
      const rel = (b.x-(p.x+PADDLE_LONG/2))/(PADDLE_LONG/2);
      const spd = Math.min(Math.hypot(b.vx,b.vy)+0.3, SPEED_MAX);
      b.vx = Math.sin(rel*(Math.PI/4))*spd;
      b.vy = Math.cos(rel*(Math.PI/4))*spd*(isP1?-1:1);
      b.y  = isP1 ? p.y-BALL_R-1 : p.y+PADDLE_SHORT+BALL_R+1;
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
  if (winner==='p1') { room.p1Wins++; room.p1Balance+=MATCH_STAKE; room.p2Balance-=MATCH_STAKE; }
  else               { room.p2Wins++; room.p2Balance+=MATCH_STAKE; room.p1Balance-=MATCH_STAKE; }
  room.results.push(winner);
  io.to(room.code).emit('matchEnd', {
    winner, p1Score: room.state.p1.score, p2Score: room.state.p2.score,
    p1Wins: room.p1Wins, p2Wins: room.p2Wins,
    p1Balance: room.p1Balance, p2Balance: room.p2Balance,
    match: room.seriesMatch, total: TOTAL_MATCHES, results: room.results,
    seriesOver: room.seriesMatch >= TOTAL_MATCHES,
    nextTier: room.seriesMatch < TOTAL_MATCHES ? TIER_LABELS[getMatchTier(room.seriesMatch+1)] : null,
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

io.on('connection', (socket) => {
  console.log('connect:', socket.id);
  socket.on('createRoom', ({ name }) => {
    const code = generateCode(), room = createRoom(code);
    rooms[code] = room;
    room.players.push({ id: socket.id, name: name||'Player 1', role: 'p1' });
    socket.join(code); socket.roomCode = code;
    socket.emit('roomCreated', { code, role: 'p1' });
  });
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', { msg: 'Room not found' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { msg: 'Room is full' }); return; }
    room.players.push({ id: socket.id, name: name||'Player 2', role: 'p2' });
    socket.join(code); socket.roomCode = code;
    socket.emit('roomJoined', { code, role: 'p2', opponentName: room.players[0].name });
    io.to(room.players[0].id).emit('opponentJoined', { opponentName: name||'Player 2' });
    room.phase = 'countdown'; initMatchState(room);
    let count = 3;
    io.to(code).emit('countdown', { count });
    const t = setInterval(() => { count--; if (count>0) io.to(code).emit('countdown',{count}); else { clearInterval(t); startGameLoop(room); } }, 1000);
  });
  socket.on('paddleMove', ({ x }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.state) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.role==='p1') room.state.p1.x = Math.max(0, Math.min(W-PADDLE_LONG, x));
    if (player.role==='p2') room.state.p2.x = Math.max(0, Math.min(W-PADDLE_LONG, x));
  });
  socket.on('nextMatch', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = true;
    if (room.players.every(p => p.ready)) { room.players.forEach(p => p.ready=false); startNextMatch(room); }
    else socket.emit('waitingForOpponent');
  });
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    if (rooms[code].interval) clearInterval(rooms[code].interval);
    io.to(code).emit('opponentLeft');
    delete rooms[code];
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Pong server on port ${PORT}`));
