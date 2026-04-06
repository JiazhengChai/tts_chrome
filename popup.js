/* popup.js — Extension popup logic */

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const isDetachedMode = query.get('detached') === '1';
const isPipMode = query.get('pip') === '1';

if (isDetachedMode) {
  document.body.classList.add('detached');
}

if (isPipMode) {
  document.body.classList.add('pip');
}

// ── Load saved settings ──

chrome.storage.sync.get(['apiKey', 'voice', 'speed'], data => {
  if (data.apiKey)  $('apiKey').value = data.apiKey;
  if (data.voice)   $('voice').value = data.voice;
  if (data.speed) {
    $('speedSlider').value = data.speed;
    $('speedVal').textContent = parseFloat(data.speed).toFixed(1);
  }
});

seedTargetTab().catch(() => {});

// ── Query current playback state from content script ──

(async () => {
  try {
    const target = await getTargetTab();
    if (!target?.tabId) return;
    const state = await getReaderState(target);
    if (state) updateButtons(state);
  } catch (e) {
    $('status').textContent = '⚠ ' + e.message;
  }
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

async function getTargetTab() {
  const target = await chrome.runtime.sendMessage({ action: 'getTargetTab' });
  if (target?.error) {
    throw new Error(target.error);
  }
  if (!target?.tabId) {
    throw new Error('Open a readable page, text document, or PDF first.');
  }
  return target;
}

function buildDocumentTarget(target) {
  return {
    tabId: target.tabId,
    url: target.url,
    title: target.title,
    mode: target.mode,
    documentType: target.documentType,
    sourceUrl: target.sourceUrl
  };
}

async function sendDocumentCommand(command, target, extra = {}) {
  return chrome.runtime.sendMessage({
    action: 'documentReaderCommand',
    command,
    target: buildDocumentTarget(target),
    ...extra
  });
}

async function getReaderState(target) {
  if (target.mode === 'document') {
    return sendDocumentCommand('getState', target);
  }

  return ensureContentScriptAndSend(target.tabId, { action: 'getState' }, target.frameId);
}

async function findSelectionFrameId(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      try {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        return Boolean(selection && !selection.isCollapsed && text.length > 0);
      } catch {
        return false;
      }
    }
  });

  const selected = results.find(result => result.result);
  return typeof selected?.frameId === 'number' ? selected.frameId : null;
}

async function seedTargetTab() {
  if (isDetachedMode || isPipMode) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }

  await chrome.runtime.sendMessage({ action: 'setTargetTab', tabId: tab.id });
}

async function getSourceTabIdForDetach() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    return tab.id;
  }

  const target = await chrome.runtime.sendMessage({ action: 'getTargetTab' });
  return target?.tabId || null;
}

async function sendCommand(msg) {
  const target = await getTargetTab();
  if (target.mode === 'document') {
    return sendDocumentCommand(msg.action, target, { speed: msg.speed });
  }

  return ensureContentScriptAndSend(target.tabId, msg, target.frameId);
}

async function ensureContentScript(tabId, frameId = null) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'getState' }, frameId === null ? undefined : { frameId });
    return;
  } catch (error) {
    if (!String(error?.message || '').includes('Receiving end does not exist')) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target: frameId === null ? { tabId } : { tabId, frameIds: [frameId] },
    files: ['styles.css']
  });
  await chrome.scripting.executeScript({
    target: frameId === null ? { tabId } : { tabId, frameIds: [frameId] },
    files: ['content.js']
  });
}

async function ensureContentScriptAndSend(tabId, msg, frameId = null) {
  await ensureContentScript(tabId, frameId);
  return chrome.tabs.sendMessage(tabId, msg, frameId === null ? undefined : { frameId });
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
    const target = await getTargetTab();
    if (target.mode === 'document') {
      const resp = await sendDocumentCommand('read', target);
      if (resp?.error) {
        throw new Error(resp.error);
      }
      $('pauseBtn').disabled = false;
      $('stopBtn').disabled  = false;
    } else {
      const frameId = target.frameId !== null ? target.frameId : await findSelectionFrameId(target.tabId);

      if (frameId !== null) {
        await chrome.runtime.sendMessage({ action: 'setTargetTab', tabId: target.tabId, frameId });
      }

      await ensureContentScriptAndSend(target.tabId, { action: 'read' }, frameId);
      $('pauseBtn').disabled = false;
      $('stopBtn').disabled  = false;
    }
  } catch (e) {
    $('status').textContent = '⚠ ' + e.message;
  } finally {
    $('readBtn').disabled = false;
  }
});

$('pauseBtn').addEventListener('click', () => sendCommand({ action: 'pause' }));

$('stopBtn').addEventListener('click', async () => {
  try {
    await sendCommand({ action: 'stop' });
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
  sendCommand({ action: 'setSpeed', speed: s }).catch(() => {});
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

$('detachBtn').addEventListener('click', async () => {
  const sourceTabId = await getSourceTabIdForDetach();
  const resp = await chrome.runtime.sendMessage({ action: 'openDetachedController', sourceTabId });
  if (resp?.error) {
    $('status').textContent = '⚠ ' + resp.error;
  }
});

if (isDetachedMode && !isPipMode) {
  $('pinBtn').addEventListener('click', async () => {
    try {
      await openPinnedController();
      $('status').textContent = 'Pinned controller opened';
    } catch (e) {
      $('status').textContent = '⚠ ' + e.message;
    }
  });
}

async function openPinnedController() {
  if (!('documentPictureInPicture' in window)) {
    throw new Error('Always-on-top mode is not supported in this Chrome version.');
  }

  if (window.documentPictureInPicture.window) {
    window.documentPictureInPicture.window.focus();
    return;
  }

  const pipWindow = await window.documentPictureInPicture.requestWindow({
    width: 380,
    height: 360
  });

  pipWindow.document.title = 'TTS Reader';
  pipWindow.document.body.style.margin = '0';
  pipWindow.document.body.style.background = '#fff';

  const iframe = pipWindow.document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('popup.html?pip=1');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.allow = 'clipboard-read; clipboard-write';

  pipWindow.document.body.replaceChildren(iframe);
}

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
