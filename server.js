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
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// --- ROUTES ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/watch.html', (req, res) => {
  res.sendFile(__dirname + '/public/watch.html');
});

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

// --- SOCKET LOGIC ---
const rooms = {}; 

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      host: socket.id,
      hostUid: data.uid, // Store the unique ID of the host
      videoSrc: '',
      welcomeMsg: '',
      users: [{ id: socket.id, uid: data.uid, name: data.name }]
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
    
    // Check if this user is the HOST reconnecting
    if (room.hostUid === data.uid) {
      console.log(`Host reconnected to ${data.roomId}`);
      room.host = socket.id; // Update the socket ID
      socket.join(data.roomId);
      
      // Find and update user entry
      const userIndex = room.users.findIndex(u => u.uid === data.uid);
      if (userIndex > -1) room.users[userIndex].id = socket.id;
      else room.users.push({ id: socket.id, uid: data.uid, name: data.name });

      // Emit 'room-created' again to restore host UI
      return socket.emit('room-created', { roomId: data.roomId });
    }

    // Check if this user is a GUEST reconnecting
    const existingUser = room.users.find(u => u.uid === data.uid);
    if (existingUser) {
      console.log(`Guest reconnected to ${data.roomId}`);
      existingUser.id = socket.id; // Update socket ID
      socket.join(data.roomId);
      
      // Send current state
      socket.emit('room-joined', { 
        roomId: data.roomId, 
        videoSrc: room.videoSrc,
        welcomeMsg: room.welcomeMsg
      });
      return;
    }

    // New Guest Logic
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    room.users.push({ id: socket.id, uid: data.uid, name: data.name });
    socket.join(data.roomId);
    
    socket.emit('room-joined', { 
      roomId: data.roomId, 
      videoSrc: room.videoSrc,
      welcomeMsg: room.welcomeMsg
    });
  });

  // Save Welcome Message
  socket.on('set-welcome-msg', (data) => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].welcomeMsg = data.msg;
    }
  });

  // WebRTC Signaling
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  // Video Sync
  socket.on('sync-video', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (data.type === 'src' && data.src) rooms[roomId].videoSrc = data.src;
    socket.broadcast.to(roomId).emit('sync-video', data);
  });

  socket.on('request-sync', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
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

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      
      // Note: We do NOT remove the user from the array immediately on disconnect.
      // This allows them to refresh and rejoin with the same UID.
      // We only remove the room if it becomes truly empty after a delay (optional).
      // For this fix, we'll keep the room alive as long as possible.
      
      // Just notify others this specific socket is gone (for audio cleanup)
      socket.to(roomId).emit('user-disconnected', { id: socket.id });
    }
  });
});

function generateRoomId() { 
  return Math.random().toString(36).substring(2, 8).toUpperCase(); 
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
