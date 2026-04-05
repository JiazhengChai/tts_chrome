/* popup.js — Extension popup logic */

const $ = id => document.getElementById(id);

// ── Load saved settings ──

chrome.storage.sync.get(['apiKey', 'voice', 'speed'], data => {
  if (data.apiKey)  $('apiKey').value = data.apiKey;
  if (data.voice)   $('voice').value = data.voice;
  if (data.speed) {
    $('speedSlider').value = data.speed;
    $('speedVal').textContent = parseFloat(data.speed).toFixed(1);
  }
});

// ── Query current playback state from content script ──

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const state = await chrome.tabs.sendMessage(tab.id, { action: 'getState' });
    if (state) updateButtons(state);
  } catch { /* content script not injected yet */ }
})();

function updateButtons(st) {
  $('pauseBtn').disabled = !st.playing;
  $('stopBtn').disabled  = !st.playing;
  $('pauseBtn').textContent = st.paused ? '▶' : '⏸';
  if (st.playing) {
    $('status').textContent = st.paused ? 'Paused' : 'Reading…';
  }
}

// ── Helpers ──

async function sendToTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  if (!isSupportedTab(tab)) {
    throw new Error('Open a normal web page first. Chrome internal pages are not supported.');
  }

  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, msg);
}

function isSupportedTab(tab) {
  const url = tab?.url || '';
  return /^https?:\/\//.test(url);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'getState' });
    return;
  } catch (error) {
    if (!String(error?.message || '').includes('Receiving end does not exist')) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['styles.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

// ── Button handlers ──

$('readBtn').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) {
    $('status').textContent = '⚠ Enter API key first';
    return;
  }
  await chrome.storage.sync.set({ apiKey: key });

  $('readBtn').disabled = true;
  $('status').textContent = 'Starting…';

  try {
    await sendToTab({ action: 'read' });
    $('pauseBtn').disabled = false;
    $('stopBtn').disabled  = false;
  } catch (e) {
    $('status').textContent = '⚠ ' + e.message;
  }
  $('readBtn').disabled = false;
});

$('pauseBtn').addEventListener('click', () => sendToTab({ action: 'pause' }));

$('stopBtn').addEventListener('click', async () => {
  try {
    await sendToTab({ action: 'stop' });
  } catch (e) {
    $('status').textContent = '⚠ ' + e.message;
  }
  $('pauseBtn').disabled = true;
  $('stopBtn').disabled  = true;
  $('pauseBtn').textContent = '⏸';
});

// ── Speed slider ──

$('speedSlider').addEventListener('input', e => {
  const s = parseFloat(e.target.value);
  $('speedVal').textContent = s.toFixed(1);
  chrome.storage.sync.set({ speed: s });
  sendToTab({ action: 'setSpeed', speed: s }).catch(() => {});
});

// ── Settings ──

$('saveKey').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (key) {
    chrome.storage.sync.set({ apiKey: key });
    $('status').textContent = '✓ API key saved';
  }
});

$('voice').addEventListener('change', e => {
  chrome.storage.sync.set({ voice: e.target.value });
});

$('clearCache').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearCache' });
  $('status').textContent = '✓ Cache cleared';
});

// ── Listen for status updates from content script ──

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action !== 'statusUpdate') return;

  $('status').textContent = msg.message;

  if (msg.status === 'playing') {
    $('pauseBtn').disabled = false;
    $('stopBtn').disabled  = false;
    $('pauseBtn').textContent = '⏸';
  } else if (msg.status === 'paused') {
    $('pauseBtn').textContent = '▶';
  } else if (msg.status === 'ready' || msg.status === 'error') {
    $('pauseBtn').disabled = true;
    $('stopBtn').disabled  = true;
    $('pauseBtn').textContent = '⏸';
  }
});
