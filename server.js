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

// Upload Route
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  // We return a path to our streaming endpoint, not the static file
  res.json({ filePath: `/stream/${req.file.filename}` });
});

// --- STREAMING ROUTE (The Fix) ---
app.get('/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // Parse the Range header (e.g., "bytes=32324-")
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Calculate chunk size (1MB chunks for smooth streaming)
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
    // If no Range header (some older browsers/devices), send the whole file
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- ERROR HANDLING ---
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
const rooms = {}; 

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

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
    console.log(`Room created: ${roomId}`);
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found or expired');
    
    socket.roomId = data.roomId;

    if (room.timeout) {
      clearTimeout(room.timeout);
      room.timeout = null;
      console.log(`Deletion cancelled for room ${data.roomId}`);
    }
    
    if (room.hostUid === data.uid) {
      room.host = socket.id; 
      const userIndex = room.users.findIndex(u => u.uid === data.uid);
      if (userIndex > -1) room.users[userIndex].id = socket.id;
      else room.users.push({ id: socket.id, uid: data.uid, name: data.name });
      socket.join(data.roomId);
      return socket.emit('room-created', { roomId: data.roomId });
    }

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
    if (socket.roomId && rooms[socket.roomId]) rooms[socket.roomId].welcomeMsg = data.msg;
  });

  socket.on('signal', (data) => io.to(data.to).emit('signal', { from: socket.id, signal: data.signal }));

  socket.on('sync-video', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (data.type === 'src' && data.src) rooms[roomId].videoSrc = data.src;
    socket.broadcast.to(roomId).emit('sync-video', data);
  });

  socket.on('request-sync', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId].host) socket.to(rooms[roomId].host).emit('get-state', { requester: socket.id });
  });

  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time });
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' });
  });

  socket.on('chat-message', (data) => {
    if(socket.roomId) io.to(socket.roomId).emit('chat-message', data);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      socket.to(roomId).emit('user-disconnected', { id: socket.id });
      const clientsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (!clientsInRoom || clientsInRoom.size === 0) {
        rooms[roomId].timeout = setTimeout(() => {
          const currentClients = io.sockets.adapter.rooms.get(roomId);
          if ((!currentClients || currentClients.size === 0) && rooms[roomId]) {
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted.`);
          }
        }, 1000 * 60 * 2); // 2 Minutes
      }
    }
  });
});

function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Add this to the top area with other variables
const gameRooms = {}; 

// ... (Keep existing code for watch party, multer, etc.) ...

// --- GAME SOCKET LOGIC (Add inside io.on('connection', ...)) ---

  // 1. Create Game Room
  socket.on('create-game-room', (data) => {
    const roomId = generateRoomId();
    gameRooms[roomId] = {
      players: [{ id: socket.id, name: data.name, symbol: 'X' }],
      board: Array(9).fill(null),
      turn: 'X',
      gameState: 'waiting', // waiting, playing, finished
      gameType: null,
      reflexState: null
    };
    socket.join(roomId);
    socket.gameRoomId = roomId;
    socket.emit('game-room-created', { roomId, name: data.name, symbol: 'X' });
  });

  // 2. Join Game Room
  socket.on('join-game-room', (data) => {
    const room = gameRooms[data.roomId];
    if (!room) return socket.emit('game-error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('game-error', 'Room is full');

    room.players.push({ id: socket.id, name: data.name, symbol: 'O' });
    socket.join(data.roomId);
    socket.gameRoomId = data.roomId;

    // Notify both players
    socket.emit('game-room-joined', { roomId: data.roomId, name: data.name, symbol: 'O' });
    
    // Start the game logic
    room.gameState = 'playing';
    io.to(data.roomId).emit('game-start', { 
      players: room.players, 
      turn: room.turn,
      board: room.board 
    });
  });

  // 3. Tic Tac Toe Move
  socket.on('ttt-move', (data) => {
    const room = gameRooms[socket.gameRoomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Check if it's this player's turn
    if (room.turn !== player.symbol) return;

    // Update board
    if (room.board[data.index] === null) {
      room.board[data.index] = player.symbol;
      
      // Check Win
      const winner = checkTTTWinner(room.board);
      if (winner) {
        room.gameState = 'finished';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: player.id, line: winner });
      } else if (room.board.every(cell => cell !== null)) {
        // Draw
        room.gameState = 'finished';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, winner: 'draw' });
      } else {
        // Switch Turn
        room.turn = room.turn === 'X' ? 'O' : 'X';
        io.to(socket.gameRoomId).emit('ttt-update', { board: room.board, turn: room.turn });
      }
    }
  });

  // 4. Reflex Duel Logic
  socket.on('start-reflex-round', () => {
    const room = gameRooms[socket.gameRoomId];
    if (!room || room.players.length < 2) return;

    io.to(socket.gameRoomId).emit('reflex-state', { status: 'waiting' });
    
    // Random delay 2-5 seconds
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

    // Cheated (tapped before GO)
    if (!room.reflexState.canTap) {
      room.reflexState.winner = 'opponent'; // Auto-win for the other person
      const opponent = room.players.find(p => p.id !== socket.id);
      io.to(socket.gameRoomId).emit('reflex-result', { winner: opponent.id, reason: 'early' });
      room.reflexState = null;
      return;
    }

    // Legit win
    if (!room.reflexState.winner) {
      room.reflexState.winner = socket.id;
      io.to(socket.gameRoomId).emit('reflex-result', { winner: socket.id, reason: 'valid' });
      room.reflexState = null;
    }
  });

  // 5. Disconnect
  socket.on('disconnect', () => {
    // ... existing watch party disconnect logic ...

    // Game disconnect logic
    if (socket.gameRoomId && gameRooms[socket.gameRoomId]) {
      io.to(socket.gameRoomId).emit('game-error', 'Opponent disconnected');
      delete gameRooms[socket.gameRoomId];
    }
  });

// ... existing helper functions ...

// Add this helper function near generateRoomId
function checkTTTWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (let line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return line; // Return winning line indices
    }
  }
  return null;
}
