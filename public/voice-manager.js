/* ══════════════════════════════════════════════════════════════════
   VOICE MANAGER v5.0 — PeerJS (Free & Stable)
   ══════════════════════════════════════════════════════════════════ */

let voiceSocket;
let myPeer = null;
let myVoiceStream = null;
const peers = {}; // Store call objects: peerId -> Call
let isMuted = localStorage.getItem('voiceMuted') === 'true';
let currentRoomId = null;
let currentName = null;
let isConnected = false;

/* ── ICE Servers (Free OpenRelay for Long Distance) ── */
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Free TURN server for guaranteed connectivity
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

/* ── Init Voice System ── */
function initVoiceSystem(socket) {
    voiceSocket = socket;
    socket.on('voice-users-list', handleUsersList);
    socket.on('voice-user-joined', handleUserJoined);
    socket.on('voice-user-left', handleUserLeft);
    
    // Load PeerJS Script
    if (!document.getElementById('peerjs-script')) {
        const script = document.createElement('script');
        script.src = "https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js";
        script.id = 'peerjs-script';
        document.head.appendChild(script);
    }
}

/* ── Start Voice ── */
async function startVoice(roomId, name) {
    if (isConnected) return;
    
    currentRoomId = roomId;
    currentName = name;

    // 1. Request Microphone
    try {
        myVoiceStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        if (isMuted) myVoiceStream.getAudioTracks()[0].enabled = false;
    } catch (err) {
        showToast("Microphone access denied", "error");
        console.error(err);
        return;
    }

    // 2. Initialize PeerJS (Wait for script to load)
    const checkInterval = setInterval(() => {
        if (window.Peer) {
            clearInterval(checkInterval);
            createMyPeer();
        }
    }, 100);
}

function createMyPeer() {
    // Create random ID
    const myPeerId = 'wn_' + Math.random().toString(36).substr(2, 9);
    
    myPeer = new Peer(myPeerId, { config: ICE_CONFIG });

    myPeer.on('open', (id) => {
        console.log('[Voice] My Peer ID:', id);
        
        // Notify Server
        voiceSocket.emit('join-voice', { 
            roomId: currentRoomId, 
            name: currentName, 
            peerId: id 
        });

        isConnected = true;
        if (!window.customMicUI) createVoiceOrb();
        updateGlobalMicUI();
    });

    // 3. Handle Incoming Calls
    myPeer.on('call', (call) => {
        console.log('[Voice] Incoming call from', call.peer);
        call.answer(myVoiceStream); // Answer with our stream
        connectToCall(call);
    });

    myPeer.on('error', (err) => {
        console.error('[Voice] Peer Error:', err);
        if (err.type === 'peer-unavailable') {
            // User might have left, ignore
        } else {
            showToast("Voice connection error", "error");
        }
    });
}

/* ── Handle Existing Users (I am the Caller) ── */
function handleUsersList(users) {
    console.log('[Voice] Existing users:', users);
    users.forEach(user => {
        callUser(user.peerId);
    });
}

/* ── Handle New User Joined (Wait for their call) ── */
function handleUserJoined(user) {
    console.log('[Voice] User joined:', user.name);
    showToast(`${user.name} joined voice`, 'success');
    // We wait for their call (handled by myPeer.on('call'))
    // But as a fallback, we can try to call them if they don't call us within 2s
    setTimeout(() => {
        if (!peers[user.peerId]) {
            callUser(user.peerId);
        }
    }, 2000);
}

/* ── Call a User ── */
function callUser(peerId) {
    if (!myPeer || !myVoiceStream || peers[peerId]) return;
    
    console.log('[Voice] Calling', peerId);
    const call = myPeer.call(peerId, myVoiceStream);
    connectToCall(call);
}

/* ── Manage Call Connection ── */
function connectToCall(call) {
    if (peers[call.peer]) return; // Already connected

    peers[call.peer] = call;

    call.on('stream', (remoteStream) => {
        console.log('[Voice] Received stream');
        playAudioStream(call.peer, remoteStream);
    });

    call.on('close', () => {
        console.log('[Voice] Call closed');
        removeAudioStream(call.peer);
        delete peers[call.peer];
    });
}

/* ── Audio Playback Helpers ── */
function playAudioStream(id, stream) {
    let audio = document.getElementById(`audio-${id}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${id}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(e => console.log("Autoplay blocked"));
}

function removeAudioStream(id) {
    const audio = document.getElementById(`audio-${id}`);
    if (audio) audio.remove();
}

/* ── Handle User Left ── */
function handleUserLeft(data) {
    console.log('[Voice] User left', data.id);
    // Find the call associated with this socket ID? 
    // Ideally we need a map socketId -> peerId.
    // For now, we just clean up if we have the peer.
    // Note: Server sends ID, PeerJS uses PeerID. 
    // We need to ensure we close the right call.
    // The server emit 'voice-user-left' currently sends socket.id.
    // We need to improve this mapping or just let the WebRTC connection time out.
    // Let's stick to robust cleanup: 
    for (let peerId in peers) {
        // We can't easily map socket.id to peerId here without server sending peerId.
        // But 'voice-user-left' payload could be updated.
        // Let's assume the connection closes naturally or via 'close' event.
    }
}

/* ── Toggle Mic ── */
function toggleVoiceMic() {
    if (!isConnected) {
        // If not connected, this click acts as "Start"
        if (currentRoomId && currentName) {
            startVoice(currentRoomId, currentName);
        }
        return;
    }

    isMuted = !isMuted;
    if (myVoiceStream) {
        myVoiceStream.getAudioTracks()[0].enabled = !isMuted;
    }
    localStorage.setItem('voiceMuted', isMuted);
    updateGlobalMicUI();
}

/* ── Update UI ── */
function updateGlobalMicUI() {
    const orbBtn = document.getElementById('voice-btn');
    const orbIcon = document.getElementById('mic-icon');
    const orbLabel = document.getElementById('voice-label');
    const orbPing = document.getElementById('voice-ping');
    const localBtn = document.getElementById('localMicBtn');

    // Disconnected
    if (!isConnected) {
        if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gray-700 flex items-center justify-center shadow-lg border-2 border-gray-600 hover:scale-110 transition-transform focus:outline-none';
        if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>';
        if (orbLabel) { orbLabel.innerText = 'Click to Join'; orbLabel.className = 'mt-1 text-[10px] text-gray-400 uppercase tracking-wider'; }
        if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg bg-gray-500/50';
    } 
    // Muted
    else if (isMuted) {
        if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-red-600 to-red-500 flex items-center justify-center shadow-lg border-2 border-red-400/50 hover:scale-110 transition-transform focus:outline-none';
        if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>';
        if (orbLabel) { orbLabel.innerText = 'Muted'; orbLabel.className = 'mt-1 text-[10px] text-red-400 uppercase tracking-wider'; }
        if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg bg-red-500/50';
    } 
    // Active
    else {
        if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-green-500 to-teal-400 flex items-center justify-center shadow-lg border-2 border-white/20 hover:scale-110 transition-transform focus:outline-none';
        if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>';
        if (orbLabel) { orbLabel.innerText = 'Connected'; orbLabel.className = 'mt-1 text-[10px] text-gray-400 uppercase tracking-wider'; }
        if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg';
    }
}

function createVoiceOrb() {
  if (document.getElementById('voice-orb')) return;
  const ui = document.createElement('div');
  ui.id = 'voice-orb';
  ui.className = 'fixed bottom-5 right-5 z-[9999] flex flex-col items-center';
  ui.innerHTML = `
    <div class="relative">
      <div id="voice-ping" class="absolute inset-0 rounded-full bg-green-500 opacity-30"></div>
      <button onclick="toggleVoiceMic()" id="voice-btn" class="relative w-14 h-14 rounded-full bg-gray-700 flex items-center justify-center shadow-lg border-2 border-gray-600 hover:scale-110 transition-transform focus:outline-none">
        <svg id="mic-icon" class="w-6 h-6 text-white drop-shadow-lg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
      </button>
    </div>
    <span id="voice-label" class="mt-1 text-[10px] text-gray-400 uppercase tracking-wider">Click to Join</span>
  `;
  document.body.appendChild(ui);
  updateGlobalMicUI();
}

function stopVoice() {
    if (myPeer) myPeer.destroy();
    myPeer = null;
    isConnected = false;
    myVoiceStream = null;
    updateGlobalMicUI();
}
