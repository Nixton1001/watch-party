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

const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 * 1024 } });
app.use(express.static('public'));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/room', (req, res) => res.sendFile(__dirname + '/public/room.html'));
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: `/stream/${req.file.filename}` });
});
app.get('/stream/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': 'video/mp4' });
    file.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- IN-MEMORY STORAGE ---
const rooms = {}; 

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. GLOBAL LOBBY (For Index.html)
  socket.on('join-lobby', (data) => {
    socket.join('global-lobby');
    socket.lobbyData = data;
    const clients = [];
    io.sockets.adapter.rooms.get('global-lobby')?.forEach(id => {
      if(id !== socket.id) {
        const s = io.sockets.sockets.get(id);
        if(s && s.lobbyData) clients.push({ id: s.id, ...s.lobbyData });
      }
    });
    socket.emit('lobby-users', clients);
    socket.to('global-lobby').emit('lobby-user-joined', { id: socket.id, ...data });
  });

  // 2. UNIFIED ROOM LOGIC
  socket.on('join-room', (data) => {
    let room = rooms[data.roomId];
    
    if (!room) {
      room = {
        id: data.roomId,
        host: socket.id,
        mode: 'lobby', 
        users: [],
        videoSrc: '', videoTime: 0, videoPlaying: false,
        gameType: null, board: null, turn: null, scores: { X: 0, O: 0 }
      };
      rooms[data.roomId] = room;
    }

    socket.join(data.roomId);
    socket.roomId = data.roomId;
    
    const user = { id: socket.id, name: data.name, uid: data.uid };
    if (room.users.length === 0) room.host = socket.id;
    
    room.users.push(user);

    // 1. Send State to User
    socket.emit('room-joined', { 
      isHost: room.host === socket.id, 
      roomState: room 
    });

    // 2. Notify Others for WebRTC & Chat
    socket.to(data.roomId).emit('user-joined', user);
  });

  // Mode Switching
  socket.on('set-mode', (data) => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
    
    room.mode = data.mode;
    if(data.gameType) room.gameType = data.gameType;
    
    if (data.mode === 'game') {
      room.board = Array(9).fill(null);
      room.turn = 'X';
      // Assign symbols
      if(room.users[0]) room.users[0].symbol = 'X';
      if(room.users[1]) room.users[1].symbol = 'O';
    }
    io.to(socket.roomId).emit('mode-changed', { mode: room.mode, roomState: room });
  });

  // WebRTC Relay
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  // Watch Sync
  socket.on('sync-video', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (data.type === 'src') room.videoSrc = data.src;
    if (data.type === 'play') { room.videoPlaying = true; room.videoTime = data.time; }
    if (data.type === 'pause') { room.videoPlaying = false; room.videoTime = data.time; }
    if (data.type === 'seek') room.videoTime = data.time;
    socket.to(socket.roomId).emit('sync-video', data);
  });

  // Game Logic
  socket.on('game-move', (data) => {
    const room = rooms[socket.roomId];
    if (!room || room.mode !== 'game') return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user || room.turn !== user.symbol) return;

    room.board[data.index] = user.symbol;
    const winLine = checkWin(room.board);
    if (winLine) {
      room.scores[user.symbol]++;
      io.to(socket.roomId).emit('game-update', { board: room.board, line: winLine, winner: user.symbol, scores: room.scores });
    } else if (room.board.every(c => c !== null)) {
      io.to(socket.roomId).emit('game-update', { board: room.board, draw: true, scores: room.scores });
    } else {
      room.turn = room.turn === 'X' ? 'O' : 'X';
      io.to(socket.roomId).emit('game-update', { board: room.board, turn: room.turn, scores: room.scores });
    }
  });

  socket.on('restart-game', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.board = Array(9).fill(null);
    room.turn = 'X';
    io.to(socket.roomId).emit('game-update', { board: room.board, turn: room.turn, scores: room.scores });
  });

  // Chat
  socket.on('chat-message', (data) => {
    io.to(socket.roomId).emit('chat-message', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Global Lobby Cleanup
    if(socket.lobbyData) socket.to('global-lobby').emit('user-disconnected', socket.id);

    // Room Cleanup
    if (socket.roomId && rooms[socket.roomId]) {
      const room = rooms[socket.roomId];
      room.users = room.users.filter(u => u.id !== socket.id);
      socket.to(socket.roomId).emit('user-disconnected', socket.id);
      if (room.users.length === 0) {
        setTimeout(() => { if (rooms[socket.roomId]?.users.length === 0) delete rooms[socket.roomId]; }, 1000 * 60 * 2);
      }
    }
  });
});

function checkWin(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (let l of lines) { const [a,x,c] = l; if (b[a] && b[a]===b[x] && b[a]===b[c]) return l; }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));
