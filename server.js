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
// Create 'uploads' folder if it doesn't exist
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Configure Multer for video uploads
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// Serve static files from 'public' folder
app.use(express.static('public'));
// Serve uploaded videos
app.use('/uploads', express.static('uploads'));

// --- ROUTES ---

// Main entry point
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Watch page route (optional, handling just in case)
app.get('/watch.html', (req, res) => {
  res.sendFile(__dirname + '/public/watch.html');
});

// Video Upload Endpoint
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

// --- SOCKET LOGIC ---
const rooms = {}; // In-Memory Storage for Rooms

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. Create Room
  socket.on('create-room', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      host: socket.id,
      videoSrc: '',
      welcomeMsg: 'Welcome!',
      users: [{ id: socket.id, name: data.name }]
    };
    socket.join(roomId);
    socket.roomId = roomId;
    console.log(`Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
  });

  // 2. Join Room
  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) {
      console.log(`Join failed: Room ${data.roomId} not found`);
      return socket.emit('error', 'Room not found or expired');
    }
    
    socket.roomId = data.roomId;
    
    // Notify Host and others
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    
    room.users.push({ id: socket.id, name: data.name });
    socket.join(data.roomId);
    
    console.log(`User ${socket.id} joined room ${data.roomId}`);
    
    socket.emit('room-joined', { 
      roomId: data.roomId, 
      videoSrc: room.videoSrc,
      welcomeMsg: room.welcomeMsg
    });
  });

  // 3. WebRTC Signaling (Crucial for PC <-> Phone connection)
  socket.on('signal', (data) => {
    // Relay signal to the specific peer
    io.to(data.to).emit('signal', { 
      from: socket.id, 
      signal: data.signal 
    });
  });

  // 4. Video Source Change (Host only)
  socket.on('change-src', (data) => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].videoSrc = data.src;
      socket.broadcast.to(socket.roomId).emit('update-src', { src: data.src });
    }
  });

  // 5. Video Sync (Play/Pause/Seek)
  socket.on('sync-video', (data) => {
    if(socket.roomId) socket.broadcast.to(socket.roomId).emit('sync-video', data);
  });

  // 6. State Request (for late joiners)
  socket.on('request-state', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      socket.to(rooms[socket.roomId].host).emit('get-state', { requester: socket.id });
    }
  });

  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time });
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' });
  });

  // 7. Chat
  socket.on('chat-message', (data) => {
    if(socket.roomId) io.to(socket.roomId).emit('chat-message', data);
  });

  // 8. Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Note: You could add logic here to remove user from room.users array
  });
});

function generateRoomId() { 
  return Math.random().toString(36).substring(2, 8).toUpperCase(); 
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
