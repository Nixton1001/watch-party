const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- SETUP ---
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Multer for Video Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 1000000000 } }); // 1GB Limit

// --- DATA STORAGE ---
const parties = {}; // General Party Info { code: { hostUID, hostSocketId, videoSrc, welcomeMsg, users } }
const gameRooms = {}; // Tic Tac Toe { code: { players: [], board: [], turn: 'X' } }
const drawRooms = {}; // Think & Draw { code: { players: [], drawer, word, ... } }
const voiceRooms = {}; // Voice Signaling { code: [ {id, name} ] }
const ludoRooms = {}; // Ludo Game { code: { players: {}, pieces: {}, turn: 'red', active: bool } }

// Word List for Think & Draw
const wordList = [
  "Apple", "Banana", "Car", "Dog", "Elephant", "Fire", "Guitar", "House", "Ice", "Jelly", 
  "Kite", "Lion", "Moon", "Night", "Orange", "Pizza", "Queen", "Rocket", "Sun", "Tree", 
  "Umbrella", "Violin", "Water", "Xylophone", "Yellow", "Zebra", "Book", "Chair", "Door", 
  "Fish", "Ghost", "Heart", "Juice", "King", "Lamp", "Mouse", "Nose", "Ocean", "Pencil", 
  "Smile", "Tiger", "Cloud", "Box", "Cat", "Drum", "Hat", "Jar", "Key", "Leaf"
];

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/watch.html', (req, res) => res.sendFile(__dirname + '/public/watch.html'));
app.get('/game.html', (req, res) => res.sendFile(__dirname + '/public/game.html'));
app.get('/draw.html', (req, res) => res.sendFile(__dirname + '/public/draw.html'));
app.get('/ludo.html', (req, res) => res.sendFile(__dirname + '/public/ludo.html'));

// Video Upload Endpoint
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {

  // ==========================================
  // --- PARTY SYSTEM (Watch & General) ---
  // ==========================================
  
  socket.on('create-party', (data) => {
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); } while (parties[code]);
    
    parties[code] = { 
        hostUID: data.uid, 
        hostSocketId: socket.id, 
        welcomeMsg: '', 
        videoSrc: '', 
        users: [socket.id] 
    };
    
    socket.join(code);
    socket.partyCode = code;
    socket.emit('party-created', { roomId: code });
  });

  socket.on('join-party', (data) => {
    const party = parties[data.roomId];
    if (!party) return socket.emit('error', 'Party not found');

    const isReconnectingHost = party.hostUID === data.uid;
    
    if (isReconnectingHost) {
        party.hostSocketId = socket.id;
    }

    if (!party.users.includes(socket.id)) {
        party.users.push(socket.id);
    }

    socket.join(data.roomId);
    socket.partyCode = data.roomId;
    
    socket.emit('party-joined', { 
      roomId: data.roomId, 
      isHost: isReconnectingHost, 
      welcomeMsg: party.welcomeMsg,
      videoSrc: party.videoSrc 
    });
  });

  socket.on('set-welcome-msg', (data) => {
    if (parties[socket.partyCode]) parties[socket.partyCode].welcomeMsg = data.msg;
  });

  socket.on('chat-message', (data) => {
    io.to(socket.partyCode).emit('chat-message', data);
  });

  // --- VIDEO SYNCING ---
  socket.on('sync-video', (data) => {
    if (data.type === 'src' && parties[socket.partyCode]) {
      parties[socket.partyCode].videoSrc = data.src;
    }
    socket.to(socket.partyCode).emit('sync-video', data);
  });

  socket.on('request-sync', () => {
    const party = parties[socket.partyCode];
    if (party && party.hostSocketId) {
      io.to(party.hostSocketId).emit('get-state', { requester: socket.id });
    }
  });

  socket.on('send-state', (data) => {
    io.to(data.to).emit('sync-video', { type: data.playing ? 'play' : 'pause', time: data.time });
  });

  // ==========================================
  // --- VOICE SYSTEM ---
  // ==========================================

  socket.on('join-voice', (data) => {
    if (!voiceRooms[data.roomId]) voiceRooms[data.roomId] = [];
    if (!voiceRooms[data.roomId].find(u => u.id === socket.id)) {
      voiceRooms[data.roomId].push({ id: socket.id, name: data.name });
    }
    socket.to(data.roomId).emit('voice-user-joined', { id: socket.id, name: data.name });
    const existingUsers = voiceRooms[data.roomId].filter(u => u.id !== socket.id);
    socket.emit('voice-users-list', existingUsers);
  });

  socket.on('voice-signal', (data) => {
    io.to(data.to).emit('voice-signal', { from: socket.id, signal: data.signal });
  });

  // ==========================================
  // --- GAME: TIC TAC TOE ---
  // ==========================================

  socket.on('join-game-room', (data) => {
    const { roomId, name } = data;
    if (!gameRooms[roomId]) {
      gameRooms[roomId] = { players: [], board: Array(9).fill(null), turn: 'X' };
    }

    const game = gameRooms[roomId];
    if (game.players.length >= 2) {
      return socket.emit('game-error', 'Game Room Full');
    }

    const symbol = game.players.length === 0 ? 'X' : 'O';
    game.players.push({ id: socket.id, name, symbol, score: 0 });

    socket.join(roomId);
    socket.gameRoomId = roomId;

    if (game.players.length === 2) {
      io.to(roomId).emit('game-start', game);
    } else {
      socket.emit('game-waiting', { symbol });
    }
  });

  socket.on('play-move', (data) => {
    const game = gameRooms[socket.gameRoomId];
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player || game.turn !== player.symbol || game.board[data.index]) return;

    game.board[data.index] = player.symbol;

    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    let winner = null;
    
    for(let w of wins) {
      const [a,b,c] = w;
      if(game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
        winner = game.board[a];
        break;
      }
    }

    if (winner) {
      const winnerPlayer = game.players.find(p => p.symbol === winner);
      if(winnerPlayer) winnerPlayer.score += 50;
      io.to(socket.gameRoomId).emit('game-update', { board: game.board, turn: game.turn, result: { winner }, players: game.players });
      game.board = Array(9).fill(null);
    } else if (!game.board.includes(null)) {
      io.to(socket.gameRoomId).emit('game-update', { board: game.board, turn: game.turn, result: { draw: true }, players: game.players });
      game.board = Array(9).fill(null);
    } else {
      game.turn = game.turn === 'X' ? 'O' : 'X';
      io.to(socket.gameRoomId).emit('game-update', { board: game.board, turn: game.turn, players: game.players });
    }
  });

  // ==========================================
  // --- GAME: THINK & DRAW ---
  // ==========================================

  function startDrawRound(roomId) {
    const room = drawRooms[roomId];
    if (!room) return;
    room.status = 'choosing';
    room.boardData = [];
    room.guessedPlayers = [];
    const drawerIndex = (room.round - 1) % room.players.length;
    room.drawer = room.players[drawerIndex];
    const words = [];
    while(words.length < 3) {
        const w = wordList[Math.floor(Math.random() * wordList.length)];
        if(!words.includes(w)) words.push(w);
    }
    io.to(room.drawer.id).emit('choose-word', { words });
    socket.to(roomId).emit('drawer-choosing', { drawerName: room.drawer.name });
    io.to(roomId).emit('draw-update', { players: room.players, drawer: room.drawer, status: room.status, round: room.round, maxRounds: room.maxRounds });
  }

  function endDrawTurn(roomId, everyoneGuessed) {
    const room = drawRooms[roomId];
    if (!room) return;
    if(room.timer) clearInterval(room.timer);
    room.status = 'results';
    io.to(roomId).emit('round-end', { word: room.word, players: room.players });
    setTimeout(() => {
        const totalTurns = room.maxRounds * room.players.length;
        if (room.round < totalTurns) {
            room.round++;
            startDrawRound(roomId);
        } else {
            io.to(roomId).emit('game-over', { players: room.players.sort((a,b) => b.score - a.score) });
            delete drawRooms[roomId];
        }
    }, 5000);
  }

  socket.on('join-draw-room', (data) => {
    const { roomId, name } = data;
    if (!drawRooms[roomId]) {
        drawRooms[roomId] = { players: [], drawer: null, word: null, boardData: [], round: 1, maxRounds: 3, timer: null, timeLeft: 60, status: 'waiting', hints: [], guessedPlayers: [] };
    }
    const room = drawRooms[roomId];
    if (!room.players.find(p => p.id === socket.id)) {
        room.players.push({ id: socket.id, name, score: 0 });
    }
    socket.join(roomId);
    socket.drawRoomId = roomId;
    if (room.players.length >= 2 && room.status === 'waiting') { startDrawRound(roomId); } 
    else { io.to(roomId).emit('draw-waiting', { players: room.players, message: 'Waiting for players...' }); }
  });

  socket.on('word-selected', (data) => {
    const room = drawRooms[socket.drawRoomId];
    if (!room || socket.id !== room.drawer.id) return;
    room.word = data.word;
    room.status = 'drawing';
    room.timeLeft = 60;
    room.hints = Array(room.word.length).fill('_');
    room.hints[0] = room.word[0]; 
    io.to(room.drawer.id).emit('your-turn', { word: room.word });
    socket.to(socket.drawRoomId).emit('start-guessing', { hint: room.hints.join(' '), length: room.word.length });
    io.to(socket.drawRoomId).emit('draw-update', { players: room.players, drawer: room.drawer, status: room.status });
    if(room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft % 15 === 0 && room.timeLeft > 0) {
             const hiddenIndices = room.hints.map((h, i) => (h === '_' ? i : -1)).filter(i => i !== -1);
             if (hiddenIndices.length > 0) { const idx = hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)]; room.hints[idx] = room.word[idx]; io.to(socket.drawRoomId).emit('update-hint', { hint: room.hints.join(' ') }); }
        }
        io.to(socket.drawRoomId).emit('timer-sync', { time: room.timeLeft });
        if (room.timeLeft <= 0) { clearInterval(room.timer); endDrawTurn(socket.drawRoomId, false); }
    }, 1000);
  });

  socket.on('draw-stroke', (data) => { socket.to(socket.drawRoomId).emit('draw-stroke', data); });
  socket.on('clear-canvas', () => { socket.to(socket.drawRoomId).emit('clear-canvas'); });

  socket.on('draw-guess', (data) => {
    const room = drawRooms[socket.drawRoomId];
    if (!room || room.status !== 'drawing' || socket.id === room.drawer.id) return;
    const guess = data.guess.toLowerCase();
    const word = room.word.toLowerCase();
    if (guess === word) {
        const points = Math.max(50, room.timeLeft * 2); 
        const player = room.players.find(p => p.id === socket.id);
        player.score += points;
        const drawer = room.players.find(p => p.id === room.drawer.id);
        drawer.score += 25; 
        room.guessedPlayers.push(socket.id);
        io.to(socket.drawRoomId).emit('correct-guess', { name: player.name, points });
        io.to(socket.drawRoomId).emit('draw-update', { players: room.players, drawer: room.drawer, status: room.status });
        if (room.guessedPlayers.length === room.players.length - 1) { clearInterval(room.timer); endDrawTurn(socket.drawRoomId, true); }
    } else {
        let isClose = false;
        if(word.includes(guess) || guess.includes(word)) isClose = true;
        io.to(socket.drawRoomId).emit('draw-chat', { name: data.name, msg: data.guess, system: false, close: isClose });
    }
  });

  // ==========================================
  // --- GAME: LUDO ---
  // ==========================================
  
  const ludoColors = ['red', 'green', 'yellow', 'blue'];

  socket.on('join-ludo', (data) => {
    const { roomId, name, uid } = data;
    if (!ludoRooms[roomId]) {
      ludoRooms[roomId] = {
        players: { red: null, green: null, yellow: null, blue: null },
        pieces: {},
        turn: 'red',
        active: false
      };
      // Init pieces
      ludoColors.forEach(c => {
        for(let i=0; i<4; i++) {
          ludoRooms[roomId].pieces[`${c}-${i}`] = { color: c, pos: 'home' };
        }
      });
    }

    const room = ludoRooms[roomId];
    
    // Check if already joined (reconnection)
    let assignedColor = null;
    for (let color of ludoColors) {
      if (room.players[color] && room.players[color].uid === uid) {
        room.players[color].id = socket.id; // Update socket ID
        assignedColor = color;
        break;
      }
    }

    // Assign new color if not reconnected
    if (!assignedColor) {
      for (let color of ludoColors) {
        if (room.players[color] === null) {
          room.players[color] = { id: socket.id, name, uid };
          assignedColor = color;
          break;
        }
      }
    }

    if (!assignedColor) return socket.emit('ludo-error', 'Game Full');

    socket.join(roomId);
    socket.ludoRoom = roomId;

    const playerCount = Object.values(room.players).filter(p => p !== null).length;
    
    // START GAME IF 2+ PLAYERS
    if(playerCount >= 2) {
        // Ensure turn is set to the first available player if restarting
        if(!room.active) {
           const firstAvailable = ludoColors.find(c => room.players[c]);
           room.turn = firstAvailable;
        }
        room.active = true;
        io.to(roomId).emit('ludo-state', room);
    } else {
        io.to(roomId).emit('ludo-waiting', { count: playerCount });
    }
  });

  socket.on('ludo-roll', (data) => {
    const room = ludoRooms[socket.ludoRoom];
    if (!room || !room.active) return;
    
    const player = room.players[room.turn];
    if (!player || player.id !== socket.id) return;

    // Broadcast the roll
    room.dice = data.result;
    io.to(socket.ludoRoom).emit('ludo-update', room);
  });

  socket.on('ludo-move', (data) => {
    const room = ludoRooms[socket.ludoRoom];
    if (!room) return;
    
    const piece = room.pieces[data.tokenId];
    if (!piece || piece.color !== room.turn) return;

    const dice = room.dice; 
    
    // Move logic
    if (piece.pos === 'home' && dice === 6) {
        piece.pos = 0; // Move out
    } else if (piece.pos !== 'home') {
        piece.pos += dice;
        // Simple finish logic (assuming path length ~57)
        if (piece.pos > 57) piece.pos = 'finished'; 
    }

    // Next Turn Logic (Skip empty slots)
    if (dice !== 6) {
        const currentIndex = ludoColors.indexOf(room.turn);
        let foundNext = false;
        
        // Loop to find next available player
        for(let i=1; i<=4; i++) {
            const nextIndex = (currentIndex + i) % 4;
            const nextColor = ludoColors[nextIndex];
            if(room.players[nextColor]) {
                room.turn = nextColor;
                foundNext = true;
                break;
            }
        }
    }

    io.to(socket.ludoRoom).emit('ludo-update', room);
  });

  socket.on('ludo-restart', (data) => {
     const room = ludoRooms[socket.ludoRoom];
     if(room) {
         const firstAvailable = ludoColors.find(c => room.players[c]);
         room.turn = firstAvailable || 'red';
         room.active = true;
         ludoColors.forEach(c => {
            for(let i=0; i<4; i++) {
              room.pieces[`${c}-${i}`] = { color: c, pos: 'home' };
            }
         });
         io.to(socket.ludoRoom).emit('ludo-state', room);
     }
  });

  // ==========================================
  // --- DISCONNECT HANDLER ---
  // ==========================================

  socket.on('disconnect', () => {
    // 1. Party Cleanup
    if (socket.partyCode && parties[socket.partyCode]) {
      const party = parties[socket.partyCode];
      party.users = party.users.filter(id => id !== socket.id);
      if (party.hostSocketId === socket.id) { party.hostSocketId = null; }
      socket.to(socket.partyCode).emit('user-disconnected', { id: socket.id });
    }
    
    // 2. Voice Cleanup
    for (let roomId in voiceRooms) {
      const len = voiceRooms[roomId].length;
      voiceRooms[roomId] = voiceRooms[roomId].filter(u => u.id !== socket.id);
      if (voiceRooms[roomId].length < len) {
         socket.to(roomId).emit('voice-user-left', { id: socket.id });
      }
    }

    // 3. Tic Tac Toe Cleanup
    if (socket.gameRoomId && gameRooms[socket.gameRoomId]) {
      delete gameRooms[socket.gameRoomId]; 
      io.to(socket.gameRoomId).emit('game-error', 'Opponent Disconnected');
    }

    // 4. Think & Draw Cleanup
    if (socket.drawRoomId && drawRooms[socket.drawRoomId]) {
        const room = drawRooms[socket.drawRoomId];
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.drawer && room.drawer.id === socket.id) {
            if(room.timer) clearInterval(room.timer);
            io.to(socket.drawRoomId).emit('round-end', { word: room.word || '---', players: room.players, error: 'Drawer Left!' });
             setTimeout(() => {
                if (room.players.length < 2) { io.to(socket.drawRoomId).emit('game-over', { players: room.players }); delete drawRooms[socket.drawRoomId]; }
                else { room.round++; startDrawRound(socket.drawRoomId); }
            }, 3000);
        } else {
             io.to(socket.drawRoomId).emit('draw-update', { players: room.players, drawer: room.drawer });
             if (room.players.length < 2) {
                 if(room.timer) clearInterval(room.timer);
                 io.to(socket.drawRoomId).emit('draw-waiting', { players: room.players, message: 'Waiting for players...' });
                 room.status = 'waiting';
             }
        }
    }

    // 5. Ludo Cleanup
    if (socket.ludoRoom && ludoRooms[socket.ludoRoom]) {
        const room = ludoRooms[socket.ludoRoom];
        // Remove player from color slot
        for(let color of ludoColors) {
            if(room.players[color] && room.players[color].id === socket.id) {
                room.players[color] = null;
            }
        }
        io.to(socket.ludoRoom).emit('ludo-error', 'A player disconnected. Game Reset.');
        delete ludoRooms[socket.ludoRoom];
    }
  });

});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Watch-Night Server running on port ${PORT}`));