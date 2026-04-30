/* ══════════════════════════════════════════════════════════════════
   VOICE MANAGER v4.0 — Jitsi Meet Integration (Free & Stable)
   Uses Jitsi Meet External API (meet.jit.si) - Lifetime Free.
   ══════════════════════════════════════════════════════════════════ */

let jitsiApi = null;
let isMuted = localStorage.getItem('voiceMuted') === 'true';
let currentRoomId = null;

/* ── Init Voice System ── */
function initVoiceSystem(socket) {
    // We still pass socket to match function signature, 
    // but Jitsi handles all the media transport.
    console.log("[Voice] Jitsi System Initialized");
}

/* ── Load Jitsi Script Dynamically ── */
function loadJitsiScript(callback) {
    if (window.JitsiMeetExternalAPI) {
        callback();
        return;
    }
    const script = document.createElement('script');
    script.src = "https://meet.jit.si/external_api.js";
    script.async = true;
    script.onload = () => {
        console.log("[Voice] Jitsi Script Loaded");
        callback();
    };
    script.onerror = () => {
        console.error("[Voice] Failed to load Jitsi script");
        showToast("Failed to load voice system", "error");
    };
    document.head.appendChild(script);
}

/* ── Start Voice ── */
function startVoice(roomId, name) {
    if (jitsiApi) {
        console.log("[Voice] Already running");
        return;
    }

    currentRoomId = roomId;

    loadJitsiScript(() => {
        try {
            // 1. Configuration
            const domain = "meet.jit.si";
            
            // Make room name obscure to avoid strangers joining
            // Jitsi requires room names without special chars usually, let's clean it.
            const safeRoomName = "WatchNight_" + roomId.replace(/[^a-zA-Z0-9]/g, '');
            
            const options = {
                roomName: safeRoomName,
                parentNode: document.body,
                configOverwrite: {
                    startWithAudioMuted: isMuted,
                    startWithVideoMuted: true,
                    audioOnly: true,
                    videoOnly: false,
                    prejoinPageEnabled: false, // Skip the preview page
                    disableDeepLinking: true,
                    enableWelcomePage: false,
                    enableClosePage: false
                },
                interfaceConfigOverwrite: {
                    filmStripOnly: false,
                    SHOW_JITSI_WATERMARK: false,
                    SHOW_WATERMARK_FOR_GUESTS: false,
                    DEFAULT_BACKGROUND: '#050505',
                    // Hiding all UI elements so it's just audio
                    TOOLBAR_BUTTONS: []
                },
                userInfo: {
                    displayName: name || "Guest"
                }
            };

            // 2. Create the Jitsi API object
            jitsiApi = new JitsiMeetExternalAPI(domain, options);

            // 3. Hide the video element immediately
            // Jitsi appends an iframe. We need to hide it.
            const iframe = jitsiApi.getIFrame();
            iframe.style.position = 'fixed';
            iframe.style.bottom = '0';
            iframe.style.right = '0';
            iframe.style.width = '1px'; // Minimal size
            iframe.style.height = '1px';
            iframe.style.opacity = '0';
            iframe.style.pointerEvents = 'none';
            iframe.style.zIndex = '-9999';

            // 4. Event Listeners
            jitsiApi.addEventListeners({
                readyToClose: () => stopVoice(),
                participantLeft: () => console.log("[Voice] Participant Left"),
                participantJoined: (participant) => {
                    console.log("[Voice] Participant Joined", participant);
                    showToast(`${participant.displayName || 'Someone'} joined voice`, 'success');
                },
                audioMuteStatusChanged: (data) => {
                    // Sync UI if muted from inside Jitsi (though UI is hidden)
                    isMuted = data.muted;
                    localStorage.setItem('voiceMuted', isMuted);
                    updateGlobalMicUI();
                }
            });

            // 5. UI
            if (!window.customMicUI) createVoiceOrb();
            updateGlobalMicUI();

            console.log(`[Voice] Joined Jitsi Room: ${safeRoomName}`);

        } catch (error) {
            console.error("[Voice] Jitsi Init Error:", error);
            showToast("Voice connection failed", "error");
        }
    });
}

/* ── Toggle Mic ── */
function toggleVoiceMic() {
    if (!jitsiApi) return;
    
    if (isMuted) {
        jitsiApi.executeCommand('toggleAudio'); // Unmute
        isMuted = false;
    } else {
        jitsiApi.executeCommand('toggleAudio'); // Mute
        isMuted = true;
    }

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

function createVoiceOrb() {
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

/* ── Stop Voice ── */
function stopVoice() {
    if (jitsiApi) {
        jitsiApi.executeCommand('hangup');
        jitsiApi.dispose();
        jitsiApi = null;
    }
    currentRoomId = null;
    const orb = document.getElementById('voice-orb');
    if (orb) orb.remove();
}
