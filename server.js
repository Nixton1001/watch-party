const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- STORAGE & MIDDLEWARE ---
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

app.use(express.static('public'));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/watch.html', (req, res) => res.sendFile(__dirname + '/public/watch.html'));
app.get('/game.html', (req, res) => res.sendFile(__dirname + '/public/game.html'));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: `/stream/${req.file.filename}` });
});

// --- STREAMING ROUTE ---
app.get('/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File size exceeds 1GB limit.' });
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// --- IN-MEMORY STORAGE ---
const rooms = {};      // Watch Party Rooms
const gameRooms = {};  // Game Zone Rooms

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // ================== WATCH PARTY LOGIC ==================
  socket.on('create-room', (data) => {
    const roomId = data.roomId || generateRoomId();
    if (rooms[roomId]) return socket.emit('error', 'Room ID collision.');
    rooms[roomId] = { host: socket.id, hostUid: data.uid, videoSrc: '', welcomeMsg: '', users: [{ id: socket.id, uid: data.uid, name: data.name }], timeout: null };
    socket.join(roomId); socket.roomId = roomId;
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found');
    socket.roomId = data.roomId;
    if (room.timeout) { clearTimeout(room.timeout); room.timeout = null; }
    if (room.hostUid === data.uid) {
      room.host = socket.id;
      const u = room.users.find(u => u.uid === data.uid);
      if (u) u.id = socket.id; else room.users.push({ id: socket.id, uid: data.uid, name: data.name });
      socket.join(data.roomId);
      return socket.emit('room-created', { roomId: data.roomId });
    }
    const existing = room.users.find(u => u.uid === data.uid);
    if (existing) { existing.id = socket.id; socket.join(data.roomId); return socket.emit('room-joined', { roomId: data.roomId, videoSrc: room.videoSrc, welcomeMsg: room.welcomeMsg }); }
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    room.users.push({ id: socket.id, uid: data.uid, name: data.name });
    socket.join(data.roomId);
    socket.emit('room-joined', { roomId: data.roomId, videoSrc: room.videoSrc, welcomeMsg: room.welcomeMsg });
  });

  socket.on('set-welcome-msg', (data) => { if (socket.roomId && rooms[socket.roomId]) rooms[socket.roomId].welcomeMsg = data.msg; });
  
  // Watch Sync
  socket.on('sync-video', (data) => { const r = socket.roomId; if (!r || !rooms[r]) return; if (data.type === 'src') rooms[r].videoSrc = data.src; socket.broadcast.to(r).emit('sync-video', data); });
  socket.on('request-sync', () => { if (socket.roomId && rooms[socket.roomId]) socket.to(rooms[socket.roomId].host).emit('get-state', { requester: socket.id }); });
  socket.on('send-state', (data) => { io.to(data.to).emit('sync-video', { type: 'seek', time: data.time }); if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' }); });
  socket.on('chat-message', (data) => { if(socket.roomId) io.to(socket.roomId).emit('chat-message', data); });

  // ================== GAME ZONE LOGIC ==================
  socket.on('create-game-room', (data) => {
    const roomId = data.roomId || generateRoomId();
    if (gameRooms[roomId]) return socket.emit('game-error', 'Room ID collision.');
    gameRooms[roomId] = {
      players: [{ id: socket.id, name: data.name, symbol: 'X' }],
      board: Array(9).fill(null), turn: 'X', gameState: 'waiting', gameType: data.gameType, reflexState: null,
      scores: { X: 0, O: 0 }
    };
    socket.join(roomId); socket.gameRoomId = roomId;
    socket.emit('game-room-created', { roomId, gameType: data.gameType });
  });

  socket.on('join-game-room', (data) => {
    const room = gameRooms[data.roomId];
    if (!room) return socket.emit('game-error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('game-error', 'Room is full');
    room.players.push({ id: socket.id, name: data.name, symbol: 'O' });
    socket.join(data.roomId); socket.gameRoomId = data.roomId;
    socket.emit('game-room-joined', { roomId: data.roomId, gameType: room.gameType });
    room.gameState = 'playing';
    io.to(data.roomId).emit('game-start', { players: room.players, turn: room.turn, board: room.board, gameType: room.gameType, scores: room.scores });
  });

  socket.on('ttt-move', (data) => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || room.gameState !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || room.turn !== player.symbol) return;
    if (room.board[data.index] === null) {
      room.board[data.index] = player.symbol;
      const winnerLine = checkTTTWinner(room.board);
      if (winnerLine) {
        room.gameState = 'finished';
        room.scores[room.board[winnerLine[0]]]++;
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: player.id, line: winnerLine, scores: room.scores });
      } else if (room.board.every(cell => cell !== null)) {
        room.gameState = 'finished';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: 'draw', scores: room.scores });
      } else {
        room.turn = room.turn === 'X' ? 'O' : 'X';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, turn: room.turn, scores: room.scores });
      }
    }
  });

  socket.on('restart-game', (data) => {
    const room = gameRooms[socket.gameRoomId];
    if (!room) return;
    room.board = Array(9).fill(null); room.turn = 'X'; room.gameState = 'playing';
    io.to(socket.gameRoomId).emit('game-start', { players: room.players, turn: room.turn, board: room.board, gameType: room.gameType, scores: room.scores });
  });

  // Reflex
  socket.on('start-reflex-round', () => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || room.players.length < 2 || room.players[0].id !== socket.id) return;
    io.to(socket.gameRoomId).emit('reflex-state', { status: 'waiting' });
    const delay = (Math.random() * 3000) + 2000;
    room.reflexState = { canTap: false, winner: null };
    setTimeout(() => {
      if (room.reflexState && !room.reflexState.winner) { room.reflexState.canTap = true; io.to(socket.gameRoomId).emit('reflex-state', { status: 'go' }); }
    }, delay);
  });

  socket.on('reflex-tap', () => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || !room.reflexState) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (!room.reflexState.canTap) {
      room.reflexState.winner = 'early';
      const opponent = room.players.find(p => p.id !== socket.id);
      room.scores[opponent.symbol]++;
      io.to(socket.gameRoomId).emit('reflex-result', { loser: socket.id, winner: opponent.id, scores: room.scores });
      room.reflexState = null; return;
    }
    if (!room.reflexState.winner) {
      room.reflexState.winner = socket.id;
      room.scores[player.symbol]++;
      io.to(socket.gameRoomId).emit('reflex-result', { winner: socket.id, scores: room.scores });
      room.reflexState = null;
    }
  });

  // ================== COMMON CALL SYSTEM (WebRTC Signaling) ==================
  // Works for BOTH Watch and Game rooms. Simply relays SDP/ICE to target socket.
  socket.on('signal', (data) => {
    // data.to = target socket ID, data.signal = SDP or ICE candidate
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  // ================== DISCONNECT ==================
  socket.on('disconnect', () => {
    // Watch Cleanup
    if (socket.roomId && rooms[socket.roomId]) {
      socket.to(socket.roomId).emit('user-disconnected', { id: socket.id });
      const clients = io.sockets.adapter.rooms.get(socket.roomId);
      if (!clients || clients.size === 0) {
        rooms[socket.roomId].timeout = setTimeout(() => {
           if (!io.sockets.adapter.rooms.get(socket.roomId) && rooms[socket.roomId]) { delete rooms[socket.roomId]; }
        }, 1000 * 60 * 2);
      }
    }
    // Game Cleanup
    if (socket.gameRoomId && gameRooms[socket.gameRoomId]) {
      io.to(socket.gameRoomId).emit('game-error', 'Opponent disconnected');
      delete gameRooms[socket.gameRoomId];
    }
  });
});

function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function checkTTTWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (let l of lines) { const [a,b,c] = l; if (b[a] && b[a]===b[b] && b[a]===b[c]) return l; }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));
