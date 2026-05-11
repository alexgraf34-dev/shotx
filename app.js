diff --git a/C:\Users\tinam\Documents\New project\app.js b/C:\Users\tinam\Documents\New project\app.js
new file mode 100644
--- /dev/null
+++ b/C:\Users\tinam\Documents\New project\app.js
@@ -0,0 +1,351 @@
+let audioCtx = null;
+let analyser = null;
+let dataArray = null;
+let highpassFilter = null;
+let wakeLock = null;
+let mediaStream = null;
+
+let isRunning = false;
+let isCalibrating = false;
+let startTime = 0;
+let lastShotTime = 0;
+let shots = [];
+let recognition = null;
+
+const AUTH_STORAGE_KEY = 'sx_auth_v3';
+const RUNS_STORAGE_KEY = 'sx_runs_v1';
+const SETTINGS_STORAGE_KEY = 'sx_settings_v1';
+
+function byId(id) { return document.getElementById(id); }
+function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
+function safeText(el, txt) { if (el) el.textContent = String(txt); }
+function safeJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return JSON.parse(fallback); } }
+
+function syncLabels() {
+  safeText(byId('sens-txt'), `${byId('sens')?.value || 58}%`);
+  safeText(byId('echo-filter-txt'), `${byId('echo-filter')?.value || 120} ms`);
+  const par = clamp(byId('par-in')?.value, 0, 60, 0);
+  safeText(byId('val-par'), par > 0 ? `${par.toFixed(1)}s` : 'OFF');
+}
+
+function getMinSplitSeconds() {
+  return clamp(byId('echo-filter')?.value, 60, 350, 120) / 1000;
+}
+
+function saveRuns() { localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(shots)); }
+function loadRuns() {
+  shots = safeJson(RUNS_STORAGE_KEY, '[]');
+  if (!Array.isArray(shots)) shots = [];
+  renderFromShots();
+}
+
+function saveSettings() {
+  const settings = {
+    sens: byId('sens')?.value,
+    par: byId('par-in')?.value,
+    delay: byId('delay-in')?.value,
+    echo: byId('echo-filter')?.value,
+    weapon: byId('calib-weapon')?.value,
+    voice: byId('voice-toggle')?.checked,
+    voiceCtrl: byId('voice-ctrl-toggle')?.checked,
+  };
+  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
+}
+
+function loadSettings() {
+  const s = safeJson(SETTINGS_STORAGE_KEY, '{}');
+  if (s.sens && byId('sens')) byId('sens').value = s.sens;
+  if (s.par && byId('par-in')) byId('par-in').value = s.par;
+  if (s.delay && byId('delay-in')) byId('delay-in').value = s.delay;
+  if (s.echo && byId('echo-filter')) byId('echo-filter').value = s.echo;
+  if (s.weapon && byId('calib-weapon')) byId('calib-weapon').value = s.weapon;
+  if (typeof s.voice === 'boolean' && byId('voice-toggle')) byId('voice-toggle').checked = s.voice;
+  if (typeof s.voiceCtrl === 'boolean' && byId('voice-ctrl-toggle')) byId('voice-ctrl-toggle').checked = s.voiceCtrl;
+  syncLabels();
+}
+
+async function hashPassword(password, saltB64) {
+  const enc = new TextEncoder();
+  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
+  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
+  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, keyMaterial, 256);
+  return btoa(String.fromCharCode(...new Uint8Array(bits)));
+}
+function randomSalt() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))); }
+function skipLocalLock() { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ localLock: false })); byId('auth-overlay').style.display = 'none'; }
+function resetLocalLock() { localStorage.removeItem(AUTH_STORAGE_KEY); location.reload(); }
+
+async function setFinalPassword() {
+  const p = byId('new-pass')?.value ?? '';
+  const c = byId('new-pass-confirm')?.value ?? '';
+  if (p !== c || p.length < 6) return alert('PIN/Passwort muss mindestens 6 Zeichen haben und übereinstimmen.');
+  const salt = randomSalt();
+  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ localLock: true, salt, hash: await hashPassword(p, salt) }));
+  location.reload();
+}
+
+async function validateLogin() {
+  const auth = safeJson(AUTH_STORAGE_KEY, '{}');
+  const input = byId('login-pass')?.value ?? '';
+  if (!auth?.hash || !auth?.salt) return;
+  if (await hashPassword(input, auth.salt) === auth.hash) byId('auth-overlay').style.display = 'none';
+}
+
+function bindSettings() {
+  ['sens', 'par-in', 'delay-in', 'echo-filter', 'voice-toggle', 'voice-ctrl-toggle', 'calib-weapon'].forEach(id => {
+    const el = byId(id);
+    if (!el) return;
+    el.addEventListener('input', () => { syncLabels(); saveSettings(); });
+    el.addEventListener('change', () => { syncLabels(); saveSettings(); applyWeaponProfile(); });
+  });
+}
+
+function applyWeaponProfile() {
+  if (!highpassFilter) return;
+  const weapon = byId('calib-weapon')?.value || 'pistol';
+  highpassFilter.frequency.value = weapon === 'rifle' ? 1700 : weapon === 'pcc' ? 950 : 1300;
+}
+
+async function initAudio() {
+  if (audioCtx) return;
+  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
+  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
+  const source = audioCtx.createMediaStreamSource(mediaStream);
+  highpassFilter = audioCtx.createBiquadFilter();
+  highpassFilter.type = 'highpass';
+  analyser = audioCtx.createAnalyser();
+  analyser.fftSize = 256;
+  analyser.smoothingTimeConstant = 0.2;
+  dataArray = new Uint8Array(analyser.frequencyBinCount);
+  applyWeaponProfile();
+  source.connect(highpassFilter);
+  highpassFilter.connect(analyser);
+}
+
+async function startCalibration() {
+  if (!audioCtx) await initAudio();
+  isCalibrating = true;
+  byId('calib-btn')?.classList.add('active');
+  safeText(byId('calib-btn'), 'LISTENING...');
+  runCalLoop();
+}
+
+function finishCalibration() {
+  isCalibrating = false;
+  byId('calib-btn')?.classList.remove('active');
+  safeText(byId('calib-btn'), 'START CALIBRATION');
+  saveSettings();
+}
+
+function runCalLoop() {
+  if (!isCalibrating || !analyser) return;
+  analyser.getByteTimeDomainData(dataArray);
+  let max = 0;
+  for (let i = 0; i < dataArray.length; i++) max = Math.max(max, Math.abs(dataArray[i] - 128) / 128);
+  if (max > 0.15) {
+    const threshold = Math.min(Math.max(Math.floor(100 - (max * 85)), 50), 95);
+    byId('sens').value = String(threshold);
+    syncLabels();
+    finishCalibration();
+  } else {
+    requestAnimationFrame(runCalLoop);
+  }
+}
+
+async function startStop() {
+  if (isRunning) return stop();
+  try {
+    if (!audioCtx) await initAudio();
+    if (audioCtx.state === 'suspended') await audioCtx.resume();
+    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
+  } catch (err) {
+    alert('Audio-Initialisierung fehlgeschlagen. Mikrofonberechtigung prüfen und App per HTTPS oder localhost öffnen.');
+    return;
+  }
+
+  isRunning = true;
+  shots = [];
+  renderFromShots();
+  safeText(byId('main-action'), 'WAITING...');
+  const par = clamp(byId('par-in')?.value, 0, 60, 0);
+  const delay = clamp(byId('delay-in')?.value, 1.5, 30, 4) * 1000;
+  syncLabels();
+
+  setTimeout(() => {
+    if (!isRunning) return;
+    beep(0.15);
+    startTime = performance.now();
+    lastShotTime = startTime;
+    safeText(byId('main-action'), 'RUNNING');
+    if (par > 0) setTimeout(() => isRunning && beep(0.2), par * 1000);
+    loop();
+  }, delay);
+}
+
+function loop() {
+  if (!isRunning || !analyser) return;
+  analyser.getByteTimeDomainData(dataArray);
+  let max = 0;
+  for (let i = 0; i < dataArray.length; i++) max = Math.max(max, Math.abs(dataArray[i] - 128) / 128);
+  const sens = clamp(byId('sens')?.value, 50, 98, 58);
+  if (max > (100 - sens) / 100) record();
+  requestAnimationFrame(loop);
+}
+
+function record() {
+  const now = performance.now();
+  const split = (now - lastShotTime) / 1000;
+  if (split < getMinSplitSeconds()) return;
+  const total = (now - startTime) / 1000;
+  lastShotTime = now;
+  shots.push({ n: shots.length + 1, t: total.toFixed(3), s: split.toFixed(2), ts: new Date().toISOString() });
+  saveRuns();
+  renderFromShots();
+}
+
+function renderFromShots() {
+  const log = byId('log');
+  if (!log) return;
+  log.textContent = '';
+  shots.slice().reverse().forEach(shot => {
+    const row = document.createElement('div');
+    row.className = 'log-entry';
+    const a = document.createElement('span'); a.textContent = `#${shot.n}`;
+    const b = document.createElement('span'); b.textContent = `${shot.t}s`;
+    const c = document.createElement('span'); c.textContent = `+${shot.s}`;
+    row.append(a, b, c);
+    log.append(row);
+  });
+  const last = shots[shots.length - 1];
+  safeText(byId('timer'), last?.t || '0.000');
+  safeText(byId('val-count'), shots.length);
+  safeText(byId('val-split'), last?.s || '0.00');
+}
+
+function stop() {
+  isRunning = false;
+  safeText(byId('main-action'), 'STAND BY');
+  if (wakeLock) wakeLock.release().catch(() => {});
+  wakeLock = null;
+  if (shots.length && byId('voice-toggle')?.checked) speak(`${shots.length} shots, ${shots[shots.length - 1].t} seconds`);
+}
+
+function resetCurrentRun() {
+  shots = [];
+  saveRuns();
+  renderFromShots();
+  isRunning = false;
+  safeText(byId('main-action'), 'STAND BY');
+}
+
+function clearAllTimes() {
+  if (!confirm('Alle gespeicherten Zeiten wirklich löschen?')) return;
+  shots = [];
+  saveRuns();
+  renderFromShots();
+}
+
+function beep(durationSeconds) {
+  if (!audioCtx) return;
+  const o = audioCtx.createOscillator();
+  const g = audioCtx.createGain();
+  o.connect(g);
+  g.connect(audioCtx.destination);
+  g.gain.value = 0.045;
+  o.frequency.value = 1250;
+  o.start();
+  o.stop(audioCtx.currentTime + clamp(durationSeconds, 0.05, 1.0, 0.15));
+}
+function speak(text) { if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
+
+function initVoiceControl() {
+  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
+  if (!SR) return;
+  recognition = new SR();
+  recognition.lang = 'en-US';
+  recognition.continuous = true;
+  recognition.interimResults = false;
+  recognition.onresult = (e) => {
+    if (!byId('voice-ctrl-toggle')?.checked) return;
+    const text = e.results[e.results.length - 1][0].transcript.toLowerCase();
+    if ((text.includes('stand-by') || text.includes('stand by')) && !isRunning) startStop();
+    if (text.includes('time') && isRunning) stop();
+  };
+  recognition.onend = () => {
+    if (byId('voice-ctrl-toggle')?.checked) {
+      try { recognition.start(); } catch {}
+    }
+  };
+  byId('voice-ctrl-toggle')?.addEventListener('change', (e) => {
+    try { e.target.checked ? recognition.start() : recognition.stop(); } catch {}
+  });
+}
+
+function toggleSaveMode(on) {
+  byId('save-mode-overlay').style.display = on ? 'flex' : 'none';
+  byId('main-display').style.opacity = on ? '0.05' : '1';
+}
+
+function exportCSV() {
+  if (!shots.length) return;
+  const csv = `Shot,Time,Split,Timestamp\n${shots.map(s => `${s.n},${s.t},${s.s},${s.ts}`).join('\n')}`;
+  const b = new Blob([csv], { type: 'text/csv' });
+  const a = document.createElement('a');
+  a.href = URL.createObjectURL(b);
+  a.download = `ShotX_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
+  a.click();
+  URL.revokeObjectURL(a.href);
+}
+
+function exportQR() {
+  if (!shots.length) return;
+  if (!window.QRCode) return alert('QR-Modul ist offline nicht verfügbar. Bitte einmal online starten oder QR-Code-Bibliothek lokal einbinden.');
+  byId('qrcode').textContent = '';
+  new QRCode(byId('qrcode'), { text: shots.map(s => s.t).join('|'), width: 200, height: 200 });
+  byId('qr-overlay').style.display = 'flex';
+}
+
+function initAuthOverlay() {
+  const overlay = byId('auth-overlay');
+  const setup = byId('phase-setup');
+  const login = byId('phase-login');
+  const a = safeJson(AUTH_STORAGE_KEY, '{}');
+  if (!overlay || !setup || !login) return;
+  if (a.localLock && a.hash && a.salt) {
+    overlay.style.display = 'flex';
+    setup.style.display = 'none';
+    login.style.display = 'block';
+  } else {
+    overlay.style.display = 'none';
+  }
+}
+
+function registerServiceWorker() {
+  if (!('serviceWorker' in navigator)) return;
+  window.addEventListener('load', () => {
+    navigator.serviceWorker.register('./sw.js').catch(() => {});
+  });
+}
+
+document.addEventListener('DOMContentLoaded', () => {
+  initAuthOverlay();
+  loadSettings();
+  loadRuns();
+  bindSettings();
+  initVoiceControl();
+  byId('main-action')?.addEventListener('click', startStop);
+  registerServiceWorker();
+});
+
+Object.assign(window, {
+  setFinalPassword,
+  skipLocalLock,
+  validateLogin,
+  resetLocalLock,
+  startCalibration,
+  exportQR,
+  exportCSV,
+  resetCurrentRun,
+  clearAllTimes,
+  toggleSaveMode,
+});
