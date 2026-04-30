/* ═══════════════════════════════════════════════════════════════════════════════
   VOICE MANAGER v2.0 — Long-Distance Fix Edition
   Fixes: NAT traversal, connection state monitoring, peer creation on join,
          auto-reconnect, robust audio handling, multiple STUN/TURN servers.
   ═══════════════════════════════════════════════════════════════════════════════ */

let voiceSocket;
let myVoiceStream = null;
const voicePeers = {};       // userId -> RTCPeerConnection
const peerRetries = {};      // userId -> retry count
let isMuted = localStorage.getItem('voiceMuted') === 'true';
let currentRoomId = null;
let currentName = null;
let reconnectTimer = null;

/* ── ICE Server List (Multiple STUN + TURN for NAT traversal) ── */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.voip.blackberry.com:3478' },
  // Public TURN servers (for symmetric NAT / long-distance)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

/* ── Init Voice System ── */
function initVoiceSystem(socket) {
  voiceSocket = socket;
  socket.on('voice-users-list', handleUsersList);
  socket.on('voice-user-joined', handleUserJoined);
  socket.on('voice-user-left', handleUserLeft);
  socket.on('voice-signal', handleVoiceSignal);

  // Listen to global join events for toast notifications
  socket.on('user-joined-msg', (data) => showToast(`${data.name} joined the party`, 'success'));
  socket.on('user-left-msg', (data) => showToast(`${data.name} left`, 'info'));
}

/* ── Start Voice ── */
async function startVoice(roomId, name) {
  if (myVoiceStream) { updateGlobalMicUI(); return; }
  currentRoomId = roomId;
  currentName = name;

  try {
    myVoiceStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      }
    });

    myVoiceStream.getAudioTracks()[0].enabled = !isMuted;

    if (!window.customMicUI) createVoiceOrb(roomId);

    voiceSocket.emit('join-voice', { roomId, name });
    updateGlobalMicUI();
    console.log('[Voice] Joined room', roomId);
  } catch (e) {
    console.error('[Voice] Mic error:', e);
    showToast('Microphone access denied. Voice chat unavailable.', 'error');
  }
}

/* ── Create Floating Mic Orb ── */
function createVoiceOrb(roomId) {
  if (document.getElementById('voice-orb')) return;
  const ui = document.createElement('div');
  ui.id = 'voice-orb';
  ui.className = 'fixed bottom-5 right-5 z-[9999] flex flex-col items-center';
  ui.innerHTML = `
    <div class="relative">
      <div id="voice-ping" class="absolute inset-0 rounded-full bg-green-500 opacity-30 animate-ping"></div>
      <button onclick="toggleVoiceMic()" id="voice-btn" class="relative w-14 h-14 rounded-full bg-gradient-to-tr from-green-500 to-teal-400 flex items-center justify-center shadow-lg border-2 border-white/20 hover:scale-110 transition-transform focus:outline-none">
        <svg id="mic-icon" class="w-6 h-6 text-white drop-shadow-lg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
      </button>
    </div>
    <span id="voice-label" class="mt-1 text-[10px] text-gray-400 uppercase tracking-wider">Connected</span>
  `;
  document.body.appendChild(ui);
}

/* ── Toggle Mic ── */
function toggleVoiceMic() {
  if (!myVoiceStream) return;
  isMuted = !isMuted;
  myVoiceStream.getAudioTracks()[0].enabled = !isMuted;
  localStorage.setItem('voiceMuted', isMuted);
  updateGlobalMicUI();
}

/* ── Update UI State ── */
function updateGlobalMicUI() {
  const orbBtn = document.getElementById('voice-btn');
  const orbIcon = document.getElementById('mic-icon');
  const orbLabel = document.getElementById('voice-label');
  const orbPing = document.getElementById('voice-ping');
  const localBtn = document.getElementById('localMicBtn');

  if (isMuted) {
    if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-red-600 to-red-500 flex items-center justify-center shadow-lg border-2 border-red-400/50 hover:scale-110 transition-transform focus:outline-none';
    if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>';
    if (orbLabel) { orbLabel.innerText = 'Muted'; orbLabel.className = 'mt-1 text-[10px] text-red-400 uppercase tracking-wider'; }
    if (orbPing) orbPing.classList.remove('animate-ping');
    if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg bg-red-500/50';
  } else {
    if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-green-500 to-teal-400 flex items-center justify-center shadow-lg border-2 border-white/20 hover:scale-110 transition-transform focus:outline-none';
    if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>';
    if (orbLabel) { orbLabel.innerText = 'Connected'; orbLabel.className = 'mt-1 text-[10px] text-gray-400 uppercase tracking-wider'; }
    if (orbPing) orbPing.classList.add('animate-ping');
    if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg';
  }
}

/* ── Handle Existing Users List ── */
function handleUsersList(users) {
  console.log('[Voice] Existing users in room:', users.length);
  users.forEach(user => createPeer(user.id, true));
}

/* ── Handle New User Joined (CRITICAL FIX) ── */
function handleUserJoined(user) {
  console.log('[Voice] New user joined:', user.name, user.id);
  createPeer(user.id, true);
  showToast(`${user.name} joined voice chat`, 'success');
}

/* ── Handle User Left ── */
function handleUserLeft(data) {
  console.log('[Voice] User left:', data.id);
  if (voicePeers[data.id]) {
    try { voicePeers[data.id].close(); } catch (e) {}
    delete voicePeers[data.id];
  }
  const el = document.getElementById(`audio-${data.id}`);
  if (el) { el.pause(); el.remove(); }
}

/* ── Create RTCPeerConnection ── */
function createPeer(userId, isCaller) {
  if (voicePeers[userId]) {
    console.log('[Voice] Peer already exists for', userId);
    return;
  }

  console.log('[Voice] Creating peer for', userId, 'isCaller:', isCaller);

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 10
  });

  voicePeers[userId] = pc;
  peerRetries[userId] = 0;

  // Add local stream tracks
  if (myVoiceStream) {
    myVoiceStream.getAudioTracks().forEach(track => {
      try { pc.addTrack(track, myVoiceStream); } catch (e) { console.error('[Voice] addTrack error:', e); }
    });
  }

  // ICE Candidate handling with trickle
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      voiceSocket.emit('voice-signal', { to: userId, signal: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[Voice] ICE state with', userId, ':', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.log('[Voice] ICE failed/disconnected for', userId, '- attempting restart');
      if (peerRetries[userId] < 3) {
        peerRetries[userId]++;
        setTimeout(() => recreatePeer(userId), 1000 * peerRetries[userId]);
      }
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[Voice] Connection state with', userId, ':', pc.connectionState);
    if (pc.connectionState === 'connected') {
      peerRetries[userId] = 0;
      showToast('Voice connected', 'success');
    } else if (pc.connectionState === 'failed') {
      console.log('[Voice] Connection failed for', userId);
      if (peerRetries[userId] < 3) {
        peerRetries[userId]++;
        setTimeout(() => recreatePeer(userId), 2000 * peerRetries[userId]);
      }
    }
  };

  // Remote track handling
  pc.ontrack = (e) => {
    console.log('[Voice] Received remote track from', userId);
    let a = document.getElementById(`audio-${userId}`);
    if (!a) {
      a = document.createElement('audio');
      a.id = `audio-${userId}`;
      a.autoplay = true;
      a.playsinline = true;
      a.volume = 1.0;
      document.body.appendChild(a);
    }
    a.srcObject = e.streams[0];
    const playPromise = a.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        console.log('[Voice] Audio play blocked, waiting for interaction');
        const unlock = () => { a.play().catch(() => {}); document.removeEventListener('click', unlock); };
        document.addEventListener('click', unlock);
      });
    }
  };

  // Negotiation (caller side)
  if (isCaller) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
          voiceActivityDetection: true
        });
        await pc.setLocalDescription(offer);
        voiceSocket.emit('voice-signal', { to: userId, signal: offer });
      } catch (err) {
        console.error('[Voice] Offer error:', err);
      }
    };
  }
}

/* ── Recreate a peer (for reconnection) ── */
function recreatePeer(userId) {
  console.log('[Voice] Recreating peer for', userId);
  if (voicePeers[userId]) {
    try { voicePeers[userId].close(); } catch (e) {}
    delete voicePeers[userId];
  }
  const el = document.getElementById(`audio-${userId}`);
  if (el) { el.pause(); el.remove(); }
  createPeer(userId, true);
}

/* ── Handle Incoming Signal ── */
async function handleVoiceSignal(data) {
  const userId = data.from;
  if (!voicePeers[userId]) createPeer(userId, false);
  const pc = voicePeers[userId];
  if (!pc) return;

  try {
    const signal = data.signal;

    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      voiceSocket.emit('voice-signal', { to: userId, signal: answer });
    }
    else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    }
    else if (signal.candidate || (signal.type === 'candidate')) {
      const candidate = signal.candidate || signal;
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('[Voice] Signal error:', err);
  }
}

/* ── Toast Notification System ── */
function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-5 right-5 z-[99999] flex flex-col gap-2';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const colors = {
    info:    'border-cyan-500/50 bg-black/80 text-cyan-300',
    success: 'border-green-500/50 bg-black/80 text-green-300',
    error:   'border-red-500/50 bg-black/80 text-red-300',
    warning: 'border-yellow-500/50 bg-black/80 text-yellow-300'
  };

  toast.className = `px-4 py-2 rounded-lg border backdrop-blur-md text-sm font-medium animate-slide-in shadow-lg ${colors[type] || colors.info}`;
  toast.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="w-2 h-2 rounded-full ${type === 'success' ? 'bg-green-400' : type === 'error' ? 'bg-red-400' : type === 'warning' ? 'bg-yellow-400' : 'bg-cyan-400'}"></span>
      ${message}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'all 0.4s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100px)';
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

/* ── Stop Voice ── */
function stopVoice() {
  Object.values(voicePeers).forEach(pc => {
    try { pc.close(); } catch (e) {}
  });
  Object.keys(voicePeers).forEach(k => delete voicePeers[k]);
  if (myVoiceStream) {
    myVoiceStream.getTracks().forEach(t => t.stop());
    myVoiceStream = null;
  }
  const orb = document.getElementById('voice-orb');
  if (orb) orb.remove();
}
