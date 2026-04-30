/* ═══════════════════════════════════════════════════════════════════════════════
   VOICE MANAGER v2.2 — Robust Signaling & Long-Distance Fix
   Fixes:
   - Signaling Glare (Collisions)
   - NAT Traversal (TURN Servers)
   - Autoplay Policies
   - Connection State Monitoring
   ═══════════════════════════════════════════════════════════════════════════════ */

let voiceSocket;
let myVoiceStream = null;
const voicePeers = {};       // userId -> RTCPeerConnection
const peerRetries = {};      // userId -> retry count
let isMuted = localStorage.getItem('voiceMuted') === 'true';
let currentRoomId = null;
let currentName = null;

/* ── ICE Server List (Multiple STUN + TURN for NAT traversal) ── */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  
  // Public TURN servers (Critical for long distance / symmetric NAT / Firewall traversal)
  // Using OpenRelay Project (Free Tier)
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
}

/* ── Start Voice ── */
async function startVoice(roomId, name) {
  // If already started, just update UI
  if (myVoiceStream) {
    updateGlobalMicUI();
    return;
  }

  currentRoomId = roomId;
  currentName = name;

  try {
    myVoiceStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      }
    });

    // Apply saved mute state
    myVoiceStream.getAudioTracks()[0].enabled = !isMuted;

    // Create floating UI orb if not using custom UI
    if (!window.customMicUI) createVoiceOrb(roomId);

    // Notify server we are joining voice
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

/* ── Handle Existing Users List (I am the NEW user) ──
   I should initiate calls to everyone already in the room.
   ─────────────────────────────────────────────────────── */
function handleUsersList(users) {
  console.log('[Voice] Existing users in room:', users.length);
  users.forEach(user => createPeer(user.id, true)); // true = I am the caller
}

/* ── Handle New User Joined (I am the EXISTING user) ──
   A new user has joined. They will send me an offer.
   I should NOT create a peer here to avoid "glare" (signaling collision).
   I will wait for their 'voice-signal' (offer).
   ─────────────────────────────────────────────────────── */
function handleUserJoined(user) {
  console.log('[Voice] New user joined:', user.name, user.id);
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
  // Avoid duplicate peers
  if (voicePeers[userId]) {
    console.log('[Voice] Peer already exists for', userId);
    return;
  }

  console.log('[Voice] Creating peer for', userId, 'isCaller:', isCaller);

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: 'all', // Use 'relay' if you want to force TURN only
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  voicePeers[userId] = pc;
  peerRetries[userId] = 0;

  // Add my local tracks to the connection
  if (myVoiceStream) {
    myVoiceStream.getAudioTracks().forEach(track => {
      try { pc.addTrack(track, myVoiceStream); } catch (e) { console.error('[Voice] addTrack error:', e); }
    });
  }

  // Handle ICE Candidates (Trickle ICE)
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      voiceSocket.emit('voice-signal', { to: userId, signal: e.candidate });
    }
  };

  // Monitor Connection State
  pc.oniceconnectionstatechange = () => {
    console.log('[Voice] ICE state with', userId, ':', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      // Attempt ICE Restart or Recreation
      if (peerRetries[userId] < 3) {
        peerRetries[userId]++;
        console.log(`[Voice] Retrying connection for ${userId} (Attempt ${peerRetries[userId]})`);
        setTimeout(() => recreatePeer(userId), 1000 * peerRetries[userId]);
      }
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[Voice] Connection state with', userId, ':', pc.connectionState);
    if (pc.connectionState === 'connected') {
      peerRetries[userId] = 0; // Reset retries on success
      showToast('Voice connected', 'success');
    }
  };

  // Handle Remote Stream
  pc.ontrack = (e) => {
    console.log('[Voice] Received remote track from', userId);
    let audioEl = document.getElementById(`audio-${userId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-${userId}`;
      audioEl.autoplay = true;
      audioEl.playsinline = true;
      audioEl.volume = 1.0;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
    
    // Play handling (browsers often block autoplay)
    const playPromise = audioEl.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        console.log('[Voice] Audio play blocked, waiting for interaction');
        // We rely on the user having clicked "Start Session" in watch.html to unlock this
      });
    }
  };

  // Logic for the CALLER (The one who initiates the offer)
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
  
  // Always assume Caller true for recreation, or implement more complex logic
  createPeer(userId, true);
}

/* ── Handle Incoming Signal ── */
async function handleVoiceSignal(data) {
  const userId = data.from;
  const signal = data.signal;

  // 1. If we receive an OFFER (They are calling us)
  if (signal.type === 'offer') {
    // If I am the caller (glare situation), compare socket IDs.
    // If my ID is higher, I ignore their offer and wait for mine to be processed.
    // For simplicity in this version, we just accept the offer if we don't have a peer yet.
    
    if (!voicePeers[userId]) createPeer(userId, false); // false = I am the answerer
    
    const pc = voicePeers[userId];
    
    // Set remote description (their offer)
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
    
    // Create and send answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    voiceSocket.emit('voice-signal', { to: userId, signal: answer });
  } 
  
  // 2. If we receive an ANSWER (They accepted our call)
  else if (signal.type === 'answer') {
    if (!voicePeers[userId]) return; // Should have a peer if we sent an offer
    const pc = voicePeers[userId];
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
  } 
  
  // 3. If we receive an ICE Candidate
  else if (signal.candidate || (signal.type === 'candidate')) {
    if (!voicePeers[userId]) return;
    const candidate = signal.candidate || signal;
    try {
      await voicePeers[userId].addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[Voice] Error adding ICE candidate', e);
    }
  }
}

/* ── Stop Voice ── */
function stopVoice() {
  Object.values(voicePeers).forEach(pc => { try { pc.close(); } catch (e) {} });
  Object.keys(voicePeers).forEach(k => delete voicePeers[k]);
  if (myVoiceStream) {
    myVoiceStream.getTracks().forEach(t => t.stop());
    myVoiceStream = null;
  }
  const orb = document.getElementById('voice-orb');
  if (orb) orb.remove();
}
