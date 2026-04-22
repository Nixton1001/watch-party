const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      host: socket.id,
      videoSrc: '',
      welcomeMsg: 'Welcome to the Party!',
      users: [{ id: socket.id, name: data.name }]
    };
    socket.join(roomId);
    socket.emit('room-created', { roomId, isHost: true });
  });

  socket.on('set-welcome', (data) => {
    const roomId = Object.keys(socket.rooms)[1];
    if (rooms[roomId] && rooms[roomId].host === socket.id) {
      rooms[roomId].welcomeMsg = data.msg;
    }
  });

  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found');
    
    socket.to(room.host).emit('user-joined', { id: socket.id, name: data.name });
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    
    room.users.push({ id: socket.id, name: data.name });
    socket.join(data.roomId);
    
    socket.emit('room-joined', { 
      roomId: data.roomId, 
      videoSrc: room.videoSrc,
      welcomeMsg: room.welcomeMsg,
      users: room.users 
    });
  });

  socket.on('signal', (data) => io.to(data.to).emit('signal', { from: socket.id, signal: data.signal }));

  socket.on('change-src', (data) => {
    const roomId = Object.keys(socket.rooms)[1];
    if (rooms[roomId]) {
      rooms[roomId].videoSrc = data.src;
      socket.broadcast.to(roomId).emit('update-src', { src: data.src });
    }
  });

  socket.on('sync-video', (data) => {
    const roomId = Object.keys(socket.rooms)[1];
    socket.broadcast.to(roomId).emit('sync-video', data);
  });

  // Guest asks for state
  socket.on('request-state', () => {
    const roomId = Object.keys(socket.rooms)[1];
    if (rooms[roomId]) {
      socket.to(rooms[roomId].host).emit('get-state', { requester: socket.id });
    }
  });

  // Host sends state back
  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time });
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' });
  });

  socket.on('chat-message', (data) => {
    const roomId = Object.keys(socket.rooms)[1];
    io.to(roomId).emit('chat-message', data);
  });

  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
