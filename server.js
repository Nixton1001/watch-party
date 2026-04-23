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
// Create 'uploads' folder safely
const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use('/uploads', express.static(uploadPath));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/watch.html', (req, res) => res.sendFile(__dirname + '/public/watch.html'));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
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
      videoSrc: '',
      welcomeMsg: 'Welcome!',
      users: [{ id: socket.id, name: data.name }]
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found');
    
    socket.roomId = data.roomId;
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    room.users.push({ id: socket.id, name: data.name });
    socket.join(data.roomId);
    
    socket.emit('room-joined', { 
      roomId: data.roomId, 
      videoSrc: room.videoSrc,
      welcomeMsg: room.welcomeMsg
    });
  });

  socket.on('signal', (data) => io.to(data.to).emit('signal', { from: socket.id, signal: data.signal }));
  socket.on('change-src', (data) => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].videoSrc = data.src;
      socket.broadcast.to(socket.roomId).emit('update-src', { src: data.src });
    }
  });
  socket.on('sync-video', (data) => { if(socket.roomId) socket.broadcast.to(socket.roomId).emit('sync-video', data); });
  socket.on('request-state', () => {
    if (socket.roomId && rooms[socket.roomId]) socket.to(rooms[socket.roomId].host).emit('get-state', { requester: socket.id });
  });
  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time });
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' });
  });
  socket.on('chat-message', (data) => { if(socket.roomId) io.to(socket.roomId).emit('chat-message', data); });
  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
