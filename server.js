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

// LIMIT: 1GB File Size
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

app.use(express.static('public'));

// --- ROUTES ---

// Main Pages
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/watch.html', (req, res) => res.sendFile(__dirname + '/public/watch.html'));
app.get('/game.html', (req, res) => res.sendFile(__dirname + '/public/game.html'));

// Upload Route
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  // Return path to our streaming endpoint
  res.json({ filePath: `/stream/${req.file.filename}` });
});

// --- STREAMING ROUTE (Supports 1GB+ Files) ---
app.get('/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- ERROR HANDLING FOR FILE SIZE ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds 1GB limit.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// --- SOCKET LOGIC ---
const rooms = {};       // Watch Party Rooms
const gameRooms = {};   // Game Zone Rooms

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // ================== WATCH PARTY LOGIC ==================

  socket.on('create-room', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      host: socket.id,
      hostUid: data.uid, 
      videoSrc: '',
      welcomeMsg: '',
      users: [{ id: socket.id, uid: data.uid, name: data.name }],
      timeout: null
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found or expired');
    
    socket.roomId = data.roomId;

    // Cancel deletion timer if reconnecting
    if (room.timeout) {
      clearTimeout(room.timeout);
      room.timeout = null;
    }
    
    // Reconnecting Host
    if (room.hostUid === data.uid) {
      room.host = socket.id;
      const userIndex = room.users.findIndex(u => u.uid === data.uid);
      if (userIndex > -1) room.users[userIndex].id = socket.id;
      else room.users.push({ id: socket.id, uid: data.uid, name: data.name });
      socket.join(data.roomId);
      return socket.emit('room-created', { roomId: data.roomId });
    }

    // Reconnecting Guest
    const existingUser = room.users.find(u => u.uid === data.uid);
    if (existingUser) {
      existingUser.id = socket.id;
      socket.join(data.roomId);
      return socket.emit('room-joined', { 
        roomId: data.roomId, 
        videoSrc: room.videoSrc,
        welcomeMsg: room.welcomeMsg
      });
    }

    // New Guest
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    room.users.push({ id: socket.id, uid: data.uid, name: data.name });
    socket.join(data.roomId);
    socket.emit('room-joined', { 
      roomId: data.roomId, 
      videoSrc: room.videoSrc,
      welcomeMsg: room.welcomeMsg
    });
  });

  socket.on('set-welcome-msg', (data) => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].welcomeMsg = data.msg;
    }
  });

  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  socket.on('sync-video', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (data.type === 'src' && data.src) rooms[roomId].videoSrc = data.src;
    socket.broadcast.to(roomId).emit('sync-video', data);
  });

  socket.on('request-sync', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId].host) {
      socket.to(rooms[roomId].host).emit('get-state', { requester: socket.id });
    }
  });

  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time });
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' });
  });

  socket.on('chat-message', (data) => {
    if(socket.roomId) io.to(socket.roomId).emit('chat-message', data);
  });

  // ================== GAME ZONE LOGIC ==================

  socket.on('create-game-room', (data) => {
    const roomId = generateRoomId();
    gameRooms[roomId] = {
      players: [{ id: socket.id, name: data.name, symbol: 'X' }],
      board: Array(9).fill(null),
      turn: 'X',
      gameState: 'waiting',
      gameType: null,
      reflexState: null
    };
    socket.join(roomId);
    socket.gameRoomId = roomId;
    socket.emit('game-room-created', { roomId, name: data.name, symbol: 'X' });
  });

  socket.on('join-game-room', (data) => {
    const room = gameRooms[data.roomId];
    if (!room) return socket.emit('game-error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('game-error', 'Room is full');

    room.players.push({ id: socket.id, name: data.name, symbol: 'O' });
    socket.join(data.roomId);
    socket.gameRoomId = data.roomId;

    socket.emit('game-room-joined', { roomId: data.roomId, name: data.name, symbol: 'O' });
    
    room.gameState = 'playing';
    io.to(data.roomId).emit('game-start', { 
      players: room.players, 
      turn: room.turn,
      board: room.board 
    });
  });

  socket.on('select-game', (data) => {
    const room = gameRooms[data.roomId];
    if (room && room.players[0].id === socket.id) {
      room.gameType = data.type;
      io.to(data.roomId).emit('game-selected', data.type);
    }
  });

  socket.on('ttt-move', (data) => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || room.gameState !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || room.turn !== player.symbol) return;

    if (room.board[data.index] === null) {
      room.board[data.index] = player.symbol;
      
      const winLine = checkTTTWinner(room.board);
      if (winLine) {
        room.gameState = 'finished';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: player.id, line: winLine });
      } else if (room.board.every(cell => cell !== null)) {
        room.gameState = 'finished';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: 'draw' });
      } else {
        room.turn = room.turn === 'X' ? 'O' : 'X';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, turn: room.turn });
      }
    }
  });

  socket.on('start-reflex-round', () => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || room.players.length < 2) return;

    io.to(socket.gameRoomId).emit('reflex-state', { status: 'waiting' });
    
    const delay = (Math.random() * 3000) + 2000;
    room.reflexState = { canTap: false, winner: null };

    setTimeout(() => {
      if (room.reflexState && !room.reflexState.winner) {
        room.reflexState.canTap = true;
        io.to(socket.gameRoomId).emit('reflex-state', { status: 'go' });
      }
    }, delay);
  });

  socket.on('reflex-tap', () => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || !room.reflexState) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (!room.reflexState.canTap) {
      room.reflexState.winner = 'opponent';
      const opponent = room.players.find(p => p.id !== socket.id);
      io.to(socket.gameRoomId).emit('reflex-result', { winner: opponent.id, reason: 'early' });
      room.reflexState = null;
      return;
    }

    if (!room.reflexState.winner) {
      room.reflexState.winner = socket.id;
      io.to(socket.gameRoomId).emit('reflex-result', { winner: socket.id, reason: 'valid' });
      room.reflexState = null;
    }
  });

  // ================== DISCONNECT LOGIC ==================

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Watch Party Disconnect
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      socket.to(roomId).emit('user-disconnected', { id: socket.id });
      const clientsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (!clientsInRoom || clientsInRoom.size === 0) {
        rooms[roomId].timeout = setTimeout(() => {
          const currentClients = io.sockets.adapter.rooms.get(roomId);
          if ((!currentClients || currentClients.size === 0) && rooms[roomId]) {
            delete rooms[roomId];
            console.log(`Watch Room ${roomId} deleted.`);
          }
        }, 1000 * 60 * 2); // 2 Minutes
      }
    }

    // Game Zone Disconnect
    const gameRoomId = socket.gameRoomId;
    if (gameRoomId && gameRooms[gameRoomId]) {
      io.to(gameRoomId).emit('game-error', 'Opponent disconnected');
      delete gameRooms[gameRoomId];
      console.log(`Game Room ${gameRoomId} deleted.`);
    }
  });
});

// --- HELPER FUNCTIONS ---

function generateRoomId() { 
  return Math.random().toString(36).substring(2, 8).toUpperCase(); 
}

function checkTTTWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Cols
    [0, 4, 8], [2, 4, 6]             // Diagonals
  ];
  for (let line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return line;
    }
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
