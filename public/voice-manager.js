/* VOICE MANAGER - PERSISTENT STATE */
let voiceSocket;
let myVoiceStream = null;
const voicePeers = {};
let isMuted = localStorage.getItem('voiceMuted') === 'true'; // Load saved state

function initVoiceSystem(socket) {
    voiceSocket = socket;
    socket.on('voice-users-list', handleUsersList);
    socket.on('voice-user-joined', handleUserJoined);
    socket.on('voice-user-left', handleUserLeft);
    socket.on('voice-signal', handleVoiceSignal);
}

async function startVoice(roomId, name) {
    // If already started, just update UI
    if (myVoiceStream) {
        updateGlobalMicUI();
        return;
    }

    try {
        myVoiceStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        myVoiceStream.getVideoTracks().forEach(track => track.stop());
        
        // Apply saved mute state immediately
        myVoiceStream.getAudioTracks()[0].enabled = !isMuted;

        // Only create floating orb if the page hasn't requested a custom UI
        if (!window.customMicUI) {
            createVoiceOrb(roomId);
        }
        
        voiceSocket.emit('join-voice', { roomId, name });
        updateGlobalMicUI(); // Update icon state
    } catch (e) {
        console.error("Mic error", e);
    }
}

function createVoiceOrb(roomId) {
    if (document.getElementById('voice-orb')) return;
    const ui = document.createElement('div');
    ui.id = 'voice-orb';
    ui.className = 'fixed bottom-20 right-5 z-[9999] flex flex-col items-center';
    ui.innerHTML = `
      <div class="relative">
        <div class="absolute inset-0 rounded-full bg-green-500 opacity-30 animate-ping"></div>
        <button onclick="toggleVoiceMic()" id="voice-btn" class="relative w-14 h-14 rounded-full bg-gradient-to-tr from-green-500 to-teal-400 flex items-center justify-center shadow-lg border-2 border-white/20 hover:scale-110 transition-transform focus:outline-none">
             <svg id="mic-icon" class="w-6 h-6 text-white drop-shadow-lg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
        </button>
      </div>
      <span id="voice-label" class="mt-1 text-[10px] text-gray-400 uppercase tracking-wider">Connected</span>
    `;
    document.body.appendChild(ui);
}

function toggleVoiceMic() {
    if (!myVoiceStream) return;
    isMuted = !isMuted;
    myVoiceStream.getAudioTracks()[0].enabled = !isMuted;
    localStorage.setItem('voiceMuted', isMuted); // Save state
    updateGlobalMicUI();
}

// Updates all Mic icons on the page (Floating orb + Local button in Watch.html)
function updateGlobalMicUI() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    // Update Floating Orb if it exists
    const orbBtn = document.getElementById('voice-btn');
    const orbIcon = document.getElementById('mic-icon');
    const orbLabel = document.getElementById('voice-label');
    
    // Update Local Watch Button if it exists
    const localBtn = document.getElementById('localMicBtn');

    if (isMuted) {
        // Orb styling
        if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-red-600 to-red-500 flex items-center justify-center shadow-lg border-2 border-red-400/50 hover:scale-110 transition-transform focus:outline-none';
        if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>';
        if (orbLabel) { orbLabel.innerText = "Muted"; orbLabel.className = "mt-1 text-[10px] text-red-400 uppercase tracking-wider"; }
        
        // Local button styling
        if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg bg-red-500/50'; 
    } else {
        // Orb styling
        if (orbBtn) orbBtn.className = 'relative w-14 h-14 rounded-full bg-gradient-to-tr from-green-500 to-teal-400 flex items-center justify-center shadow-lg border-2 border-white/20 hover:scale-110 transition-transform focus:outline-none';
        if (orbIcon) orbIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>';
        if (orbLabel) { orbLabel.innerText = "Connected"; orbLabel.className = "mt-1 text-[10px] text-gray-400 uppercase tracking-wider"; }
        
        // Local button styling
        if (localBtn) localBtn.className = 'control-btn p-2 rounded-lg';
    }
}

function handleUsersList(users) { users.forEach(user => createPeer(user.id, true)); }
function handleUserJoined(user) { }
function handleUserLeft(data) { if (voicePeers[data.id]) { voicePeers[data.id].close(); delete voicePeers[data.id]; } const el = document.getElementById(`audio-${data.id}`); if(el) el.remove(); }

function createPeer(userId, isCaller) {
    if (voicePeers[userId]) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    voicePeers[userId] = pc;
    if (myVoiceStream) myVoiceStream.getAudioTracks().forEach(track => pc.addTrack(track, myVoiceStream));
    pc.onicecandidate = (e) => { if (e.candidate) voiceSocket.emit('voice-signal', { to: userId, signal: e.candidate }); };
    pc.ontrack = (e) => { let a = document.getElementById(`audio-${userId}`); if (!a) { a = document.createElement('audio'); a.id = `audio-${userId}`; a.autoplay = true; document.body.appendChild(a); } a.srcObject = e.streams[0]; a.play(); };
    if (isCaller) pc.onnegotiationneeded = async () => { try { const o = await pc.createOffer(); await pc.setLocalDescription(o); voiceSocket.emit('voice-signal', { to: userId, signal: o }); } catch (err) {} };
}

async function handleVoiceSignal(data) {
    const userId = data.from;
    if (!voicePeers[userId]) createPeer(userId, false);
    const pc = voicePeers[userId];
    try {
        if (data.signal.type === 'offer') { await pc.setRemoteDescription(new RTCSessionDescription(data.signal)); const a = await pc.createAnswer(); await pc.setLocalDescription(a); voiceSocket.emit('voice-signal', { to: userId, signal: a }); } 
        else if (data.signal.type === 'answer') { await pc.setRemoteDescription(new RTCSessionDescription(data.signal)); } 
        else if (data.signal.candidate) { await pc.addIceCandidate(new RTCIceCandidate(data.signal)); }
    } catch (err) {}
}
