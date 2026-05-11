diff --git a/C:\Users\tinam\Documents\New project\app.js b/C:\Users\tinam\Documents\New project\app.js
new file mode 100644
--- /dev/null
+++ b/C:\Users\tinam\Documents\New project\app.js
@@ -0,0 +1,518 @@
+'use strict';
+
+const KEYS = {
+  auth: 'shotx.auth.v1',
+  settings: 'shotx.settings.v1',
+  lastRun: 'shotx.lastRun.v1',
+};
+
+const state = {
+  audioCtx: null,
+  analyser: null,
+  dataArray: null,
+  highpass: null,
+  mediaStream: null,
+  wakeLock: null,
+  recognition: null,
+  mode: 'idle',
+  startedAt: 0,
+  lastShotAt: 0,
+  shots: [],
+  raf: 0,
+  timers: [],
+};
+
+const $ = (id) => document.getElementById(id);
+
+function clamp(value, min, max, fallback) {
+  const number = Number(value);
+  if (!Number.isFinite(number)) return fallback;
+  return Math.min(max, Math.max(min, number));
+}
+
+function readJson(key, fallback) {
+  try {
+    const value = JSON.parse(localStorage.getItem(key));
+    return value ?? fallback;
+  } catch {
+    return fallback;
+  }
+}
+
+function writeJson(key, value) {
+  localStorage.setItem(key, JSON.stringify(value));
+}
+
+function setText(id, value) {
+  const el = $(id);
+  if (el) el.textContent = String(value);
+}
+
+function setMode(mode, label) {
+  state.mode = mode;
+  document.body.classList.remove('idle', 'ready', 'waiting', 'running');
+  document.body.classList.add(mode);
+  setText('status-text', label);
+  setText('main-action', mode === 'running' || mode === 'waiting' ? 'Stopp' : 'Start');
+}
+
+function getSettings() {
+  return {
+    profile: $('profile').value,
+    sensitivity: clamp($('sensitivity').value, 50, 98, 58),
+    echoMs: clamp($('echo-filter').value, 60, 350, 120),
+    delaySeconds: clamp($('delay').value, 0.5, 30, 4),
+    parSeconds: clamp($('par').value, 0, 60, 0),
+    voice: $('voice').checked,
+    voiceControl: $('voice-control').checked,
+  };
+}
+
+function saveSettings() {
+  writeJson(KEYS.settings, getSettings());
+}
+
+function loadSettings() {
+  const settings = readJson(KEYS.settings, null);
+  if (!settings) return;
+  if (settings.profile) $('profile').value = settings.profile;
+  if (settings.sensitivity) $('sensitivity').value = settings.sensitivity;
+  if (settings.echoMs) $('echo-filter').value = settings.echoMs;
+  if (settings.delaySeconds) $('delay').value = settings.delaySeconds;
+  if (settings.parSeconds !== undefined) $('par').value = settings.parSeconds;
+  if (typeof settings.voice === 'boolean') $('voice').checked = settings.voice;
+  if (typeof settings.voiceControl === 'boolean') $('voice-control').checked = settings.voiceControl;
+}
+
+function updateUi() {
+  const settings = getSettings();
+  setText('sensitivity-text', `${settings.sensitivity}%`);
+  setText('echo-text', `${settings.echoMs} ms`);
+  setText('val-par', settings.parSeconds > 0 ? `${settings.parSeconds.toFixed(1)}s` : 'OFF');
+
+  const last = state.shots[state.shots.length - 1];
+  setText('timer', last?.time ?? '0.000');
+  setText('val-count', state.shots.length);
+  setText('val-split', last?.split ?? '0.00');
+  renderLog();
+}
+
+function renderLog() {
+  const log = $('log');
+  log.textContent = '';
+
+  if (!state.shots.length) {
+    const empty = document.createElement('div');
+    empty.className = 'log-empty';
+    empty.textContent = 'Noch keine Shots';
+    log.append(empty);
+    return;
+  }
+
+  [...state.shots].reverse().forEach((shot) => {
+    const row = document.createElement('div');
+    row.className = 'log-row';
+    row.append(textSpan(`#${shot.number}`), textSpan(`${shot.time}s`), textSpan(`+${shot.split}`));
+    log.append(row);
+  });
+}
+
+function textSpan(text) {
+  const span = document.createElement('span');
+  span.textContent = text;
+  return span;
+}
+
+function applyProfile() {
+  if (!state.highpass) return;
+  const profile = $('profile').value;
+  state.highpass.frequency.value = profile === 'rifle' ? 1700 : profile === 'pcc' ? 950 : 1300;
+}
+
+async function ensureAudio() {
+  if (state.audioCtx) return;
+
+  if (!navigator.mediaDevices?.getUserMedia) {
+    throw new Error('Mikrofon ist in diesem Browser nicht verfügbar.');
+  }
+
+  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
+  state.mediaStream = await navigator.mediaDevices.getUserMedia({
+    audio: {
+      echoCancellation: false,
+      noiseSuppression: false,
+      autoGainControl: false,
+    },
+  });
+
+  const source = state.audioCtx.createMediaStreamSource(state.mediaStream);
+  state.highpass = state.audioCtx.createBiquadFilter();
+  state.highpass.type = 'highpass';
+
+  state.analyser = state.audioCtx.createAnalyser();
+  state.analyser.fftSize = 512;
+  state.analyser.smoothingTimeConstant = 0.12;
+  state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);
+
+  applyProfile();
+  source.connect(state.highpass);
+  state.highpass.connect(state.analyser);
+}
+
+async function startRun() {
+  try {
+    await ensureAudio();
+    if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
+    await requestWakeLock();
+  } catch (error) {
+    alert(`${error.message || 'Audio konnte nicht gestartet werden'}\n\nBitte Mikrofon erlauben und ShotX über HTTPS oder localhost öffnen.`);
+    return;
+  }
+
+  clearRunTimers();
+  state.shots = [];
+  updateUi();
+  saveLastRun();
+
+  const settings = getSettings();
+  setMode('waiting', 'Warte auf Startsignal');
+
+  state.timers.push(window.setTimeout(() => {
+    if (state.mode !== 'waiting') return;
+    beep(0.14);
+    state.startedAt = performance.now();
+    state.lastShotAt = state.startedAt;
+    setMode('running', 'Läuft');
+
+    if (settings.parSeconds > 0) {
+      state.timers.push(window.setTimeout(() => {
+        if (state.mode === 'running') beep(0.22);
+      }, settings.parSeconds * 1000));
+    }
+
+    detectLoop();
+  }, settings.delaySeconds * 1000));
+}
+
+function stopRun() {
+  clearRunTimers();
+  cancelAnimationFrame(state.raf);
+  releaseWakeLock();
+  setMode('ready', 'Bereit');
+
+  const settings = getSettings();
+  const last = state.shots[state.shots.length - 1];
+  if (settings.voice && last) speak(`${state.shots.length} shots, ${last.time} seconds`);
+}
+
+function clearRunTimers() {
+  state.timers.forEach((timer) => clearTimeout(timer));
+  state.timers = [];
+}
+
+function detectLoop() {
+  if (state.mode !== 'running' || !state.analyser) return;
+
+  const peak = readPeak();
+  const settings = getSettings();
+  const threshold = (100 - settings.sensitivity) / 100;
+
+  if (peak > threshold) recordShot(settings.echoMs / 1000);
+  state.raf = requestAnimationFrame(detectLoop);
+}
+
+function readPeak() {
+  state.analyser.getByteTimeDomainData(state.dataArray);
+  let peak = 0;
+  for (let i = 0; i < state.dataArray.length; i += 1) {
+    peak = Math.max(peak, Math.abs(state.dataArray[i] - 128) / 128);
+  }
+  return peak;
+}
+
+function recordShot(minSplitSeconds) {
+  const now = performance.now();
+  const split = (now - state.lastShotAt) / 1000;
+  if (split < minSplitSeconds) return;
+
+  const total = (now - state.startedAt) / 1000;
+  state.lastShotAt = now;
+  state.shots.push({
+    number: state.shots.length + 1,
+    time: total.toFixed(3),
+    split: split.toFixed(2),
+    timestamp: new Date().toISOString(),
+  });
+
+  updateUi();
+  saveLastRun();
+}
+
+async function calibrate() {
+  const button = $('calibrate');
+  try {
+    await ensureAudio();
+    if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
+  } catch (error) {
+    alert(`${error.message || 'Kalibrierung nicht möglich'}\n\nBitte Mikrofon erlauben.`);
+    return;
+  }
+
+  button.classList.add('active');
+  button.textContent = 'Lauschuss abgeben';
+  setMode('ready', 'Kalibrierung aktiv');
+
+  const started = performance.now();
+  const tick = () => {
+    const peak = readPeak();
+    if (peak > 0.12) {
+      const next = Math.round(clamp(100 - peak * 85, 50, 95, 58));
+      $('sensitivity').value = String(next);
+      finishCalibration();
+      return;
+    }
+    if (performance.now() - started > 10000) {
+      finishCalibration();
+      alert('Kein deutlicher Impuls erkannt. Empfindlichkeit manuell einstellen oder erneut kalibrieren.');
+      return;
+    }
+    requestAnimationFrame(tick);
+  };
+  requestAnimationFrame(tick);
+}
+
+function finishCalibration() {
+  $('calibrate').classList.remove('active');
+  $('calibrate').textContent = 'Kalibrieren';
+  updateUi();
+  saveSettings();
+  setMode('ready', 'Bereit');
+}
+
+function resetRun() {
+  clearRunTimers();
+  cancelAnimationFrame(state.raf);
+  state.shots = [];
+  saveLastRun();
+  updateUi();
+  setMode('ready', 'Bereit');
+}
+
+function clearAll() {
+  if (!confirm('Alle gespeicherten Zeiten löschen?')) return;
+  resetRun();
+}
+
+function saveLastRun() {
+  writeJson(KEYS.lastRun, state.shots);
+}
+
+function loadLastRun() {
+  const shots = readJson(KEYS.lastRun, []);
+  state.shots = Array.isArray(shots) ? shots : [];
+}
+
+function exportCsv() {
+  if (!state.shots.length) {
+    alert('Keine Zeiten zum Exportieren.');
+    return;
+  }
+
+  const rows = ['Shot,Time,Split,Timestamp', ...state.shots.map((shot) => `${shot.number},${shot.time},${shot.split},${shot.timestamp}`)];
+  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
+  const link = document.createElement('a');
+  link.href = URL.createObjectURL(blob);
+  link.download = `ShotX_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
+  link.click();
+  URL.revokeObjectURL(link.href);
+}
+
+function exportQr() {
+  if (!state.shots.length) {
+    alert('Keine Zeiten für QR.');
+    return;
+  }
+
+  if (!window.QRCode) {
+    alert('QR ist offline nicht verfügbar. Bitte einmal online öffnen oder die QR-Bibliothek lokal einbinden.');
+    return;
+  }
+
+  const target = $('qrcode');
+  target.textContent = '';
+  new QRCode(target, {
+    text: JSON.stringify({ app: 'ShotX', shots: state.shots }),
+    width: 220,
+    height: 220,
+  });
+  $('qr-overlay').classList.add('open');
+}
+
+function beep(durationSeconds) {
+  if (!state.audioCtx) return;
+  const oscillator = state.audioCtx.createOscillator();
+  const gain = state.audioCtx.createGain();
+  oscillator.frequency.value = 1250;
+  gain.gain.value = 0.045;
+  oscillator.connect(gain);
+  gain.connect(state.audioCtx.destination);
+  oscillator.start();
+  oscillator.stop(state.audioCtx.currentTime + durationSeconds);
+}
+
+function speak(text) {
+  if (!('speechSynthesis' in window)) return;
+  window.speechSynthesis.cancel();
+  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
+}
+
+async function requestWakeLock() {
+  if (!('wakeLock' in navigator)) return;
+  try {
+    state.wakeLock = await navigator.wakeLock.request('screen');
+  } catch {
+    state.wakeLock = null;
+  }
+}
+
+function releaseWakeLock() {
+  state.wakeLock?.release().catch(() => {});
+  state.wakeLock = null;
+}
+
+function setupVoiceControl() {
+  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
+  if (!SpeechRecognition) {
+    $('voice-control').disabled = true;
+    return;
+  }
+
+  state.recognition = new SpeechRecognition();
+  state.recognition.lang = 'en-US';
+  state.recognition.continuous = true;
+  state.recognition.interimResults = false;
+  state.recognition.onresult = (event) => {
+    const text = event.results[event.results.length - 1][0].transcript.toLowerCase();
+    if ((text.includes('stand by') || text.includes('stand-by') || text.includes('start')) && state.mode !== 'running' && state.mode !== 'waiting') startRun();
+    if ((text.includes('time') || text.includes('stop')) && (state.mode === 'running' || state.mode === 'waiting')) stopRun();
+  };
+  state.recognition.onend = () => {
+    if ($('voice-control').checked) {
+      try { state.recognition.start(); } catch {}
+    }
+  };
+}
+
+function updateVoiceControl() {
+  if (!state.recognition) return;
+  try {
+    if ($('voice-control').checked) state.recognition.start();
+    else state.recognition.stop();
+  } catch {}
+}
+
+async function hashPassword(password, saltBase64) {
+  const encoder = new TextEncoder();
+  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
+  const salt = Uint8Array.from(atob(saltBase64), (char) => char.charCodeAt(0));
+  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, material, 256);
+  return btoa(String.fromCharCode(...new Uint8Array(bits)));
+}
+
+function randomSalt() {
+  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
+}
+
+function setupAuth() {
+  const auth = readJson(KEYS.auth, {});
+  const overlay = $('auth-overlay');
+  if (auth.localLock && auth.hash && auth.salt) {
+    $('auth-setup').hidden = true;
+    $('auth-login').hidden = false;
+    overlay.classList.add('open');
+  }
+
+  $('save-pin').addEventListener('click', async () => {
+    const pass = $('new-pass').value;
+    const confirmPass = $('new-pass-confirm').value;
+    if (pass.length < 6 || pass !== confirmPass) {
+      alert('PIN/Passwort muss mindestens 6 Zeichen haben und übereinstimmen.');
+      return;
+    }
+    const salt = randomSalt();
+    writeJson(KEYS.auth, { localLock: true, salt, hash: await hashPassword(pass, salt) });
+    overlay.classList.remove('open');
+  });
+
+  $('skip-pin').addEventListener('click', () => {
+    writeJson(KEYS.auth, { localLock: false });
+    overlay.classList.remove('open');
+  });
+
+  $('login').addEventListener('click', async () => {
+    const current = readJson(KEYS.auth, {});
+    const hash = await hashPassword($('login-pass').value, current.salt);
+    if (hash === current.hash) overlay.classList.remove('open');
+    else alert('PIN stimmt nicht.');
+  });
+
+  $('reset-pin').addEventListener('click', () => {
+    localStorage.removeItem(KEYS.auth);
+    overlay.classList.remove('open');
+  });
+}
+
+function registerServiceWorker() {
+  if (!('serviceWorker' in navigator)) return;
+  window.addEventListener('load', () => {
+    navigator.serviceWorker.register('./sw.js').catch(() => {});
+  });
+}
+
+function bindEvents() {
+  $('main-action').addEventListener('click', () => {
+    if (state.mode === 'running' || state.mode === 'waiting') stopRun();
+    else startRun();
+  });
+
+  $('calibrate').addEventListener('click', calibrate);
+  $('reset').addEventListener('click', resetRun);
+  $('clear').addEventListener('click', clearAll);
+  $('csv').addEventListener('click', exportCsv);
+  $('qr').addEventListener('click', exportQr);
+  $('close-qr').addEventListener('click', () => $('qr-overlay').classList.remove('open'));
+  $('qr-overlay').addEventListener('click', (event) => {
+    if (event.target === $('qr-overlay')) $('qr-overlay').classList.remove('open');
+  });
+
+  ['profile', 'sensitivity', 'echo-filter', 'delay', 'par', 'voice'].forEach((id) => {
+    $(id).addEventListener('input', () => {
+      applyProfile();
+      updateUi();
+      saveSettings();
+    });
+    $(id).addEventListener('change', saveSettings);
+  });
+
+  $('voice-control').addEventListener('change', () => {
+    updateVoiceControl();
+    saveSettings();
+  });
+
+  document.addEventListener('visibilitychange', () => {
+    if (document.visibilityState === 'visible' && (state.mode === 'running' || state.mode === 'waiting')) requestWakeLock();
+  });
+}
+
+function init() {
+  setupAuth();
+  loadSettings();
+  loadLastRun();
+  bindEvents();
+  setupVoiceControl();
+  updateUi();
+  setMode('ready', 'Bereit');
+  registerServiceWorker();
+}
+
+document.addEventListener('DOMContentLoaded', init);
