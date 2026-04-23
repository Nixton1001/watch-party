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
app.get('/room', (req, res) => res.sendFile(__dirname + '/public/room.html')); // The Lobby
app.get('/watch.html', (req, res) => res.sendFile(__dirname + '/public/watch.html'));
app.get('/game.html', (req, res) => res.sendFile(__dirname + '/public/game.html'));

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
const rooms = {}; // General Room Info
const watchRooms = {}; // Specific Watch State
const gameRooms = {}; // Specific Game State

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. GLOBAL LOBBY (Index.html)
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

  // 2. ROOM LOBBY (room.html - The Category Selector)
  socket.on('join-waiting', (data) => {
    socket.join(data.roomId);
    socket.roomId = data.roomId;
    // Just keep track of who is in the general room for now
    if (!rooms[data.roomId]) rooms[data.roomId] = { users: [] };
    rooms[data.roomId].users.push({ id: socket.id, name: data.name });
    io.to(data.roomId).emit('lobby-update', { code: data.roomId });
  });

  // 3. WATCH PARTY LOGIC (watch.html)
  socket.on('create-room', (data) => {
    const roomId = data.roomId;
    if (!watchRooms[roomId]) watchRooms[roomId] = { host: socket.id, hostUid: data.uid, videoSrc: '', welcomeMsg: '', users: [] };
    
    watchRooms[roomId].host = socket.id;
    watchRooms[roomId].users.push({ id: socket.id, uid: data.uid, name: data.name });
    socket.join(roomId); 
    socket.roomId = roomId;
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', (data) => {
    const room = watchRooms[data.roomId];
    if (!room) return socket.emit('error', 'Room not found');
    socket.roomId = data.roomId;
    
    socket.join(data.roomId);
    socket.to(data.roomId).emit('user-joined', { id: socket.id, name: data.name });
    room.users.push({ id: socket.id, uid: data.uid, name: data.name });
    
    socket.emit('room-joined', { roomId: data.roomId, videoSrc: room.videoSrc, welcomeMsg: room.welcomeMsg });
  });

  socket.on('sync-video', (data) => { 
    const r = socket.roomId; 
    if (!r || !watchRooms[r]) return; 
    if (data.type === 'src') watchRooms[r].videoSrc = data.src; 
    socket.broadcast.to(r).emit('sync-video', data); 
  });

  socket.on('request-sync', () => { 
    if (socket.roomId && watchRooms[socket.roomId]) 
      socket.to(watchRooms[socket.roomId].host).emit('get-state', { requester: socket.id }); 
  });
  
  socket.on('send-state', (data) => { 
    io.to(data.to).emit('sync-video', { type: 'seek', time: data.time }); 
    if(data.playing) io.to(data.to).emit('sync-video', { type: 'play' }); 
  });

  socket.on('chat-message', (data) => { if(socket.roomId) io.to(socket.roomId).emit('chat-message', data); });

  // 4. COMMON SIGNALING (WebRTC)
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  // 5. DISCONNECT
  socket.on('disconnect', () => {
    if(socket.lobbyData) socket.to('global-lobby').emit('user-disconnected', socket.id);
    
    // Clean up general room
    if (socket.roomId && rooms[socket.roomId]) {
       rooms[socket.roomId].users = rooms[socket.roomId].users.filter(u => u.id !== socket.id);
    }
    // Clean up watch room
    if (socket.roomId && watchRooms[socket.roomId]) {
       watchRooms[socket.roomId].users = watchRooms[socket.roomId].users.filter(u => u.id !== socket.id);
       socket.to(socket.roomId).emit('user-disconnected', { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));
