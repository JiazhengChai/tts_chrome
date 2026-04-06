/* popup.js — Extension popup logic */

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const isDetachedMode = query.get('detached') === '1';
const isPipMode = query.get('pip') === '1';
const PROVIDERS = {
  GOOGLE: 'google',
  OPENAI: 'openai'
};
const DEFAULT_GOOGLE_VOICE = 'ja-JP-Neural2-B';
const DEFAULT_OPENAI_VOICE = 'alloy';
const VOICE_OPTIONS = {
  google: [
    {
      label: 'Japanese',
      options: [
        ['ja-JP-Neural2-B', 'ja-JP Neural2-B (Female)'],
        ['ja-JP-Neural2-C', 'ja-JP Neural2-C (Male)'],
        ['ja-JP-Neural2-D', 'ja-JP Neural2-D (Female)'],
        ['ja-JP-Wavenet-A', 'ja-JP Wavenet-A (Female)'],
        ['ja-JP-Wavenet-B', 'ja-JP Wavenet-B (Female)'],
        ['ja-JP-Wavenet-D', 'ja-JP Wavenet-D (Male)']
      ]
    },
    {
      label: 'English',
      options: [
        ['en-US-Neural2-F', 'en-US Neural2-F (Female)'],
        ['en-US-Neural2-J', 'en-US Neural2-J (Male)'],
        ['en-US-Neural2-A', 'en-US Neural2-A (Male)'],
        ['en-US-Wavenet-F', 'en-US Wavenet-F (Female)'],
        ['en-US-Wavenet-D', 'en-US Wavenet-D (Male)'],
        ['en-GB-Neural2-A', 'en-GB Neural2-A (Female)'],
        ['en-GB-Neural2-B', 'en-GB Neural2-B (Male)']
      ]
    }
  ],
  openai: [
    {
      label: 'Built-in',
      options: [
        ['alloy', 'alloy'],
        ['ash', 'ash'],
        ['coral', 'coral'],
        ['echo', 'echo'],
        ['fable', 'fable'],
        ['nova', 'nova'],
        ['onyx', 'onyx'],
        ['sage', 'sage'],
        ['shimmer', 'shimmer']
      ]
    }
  ]
};

let activeProvider = PROVIDERS.GOOGLE;

async function getSettings() {
  const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response?.settings || {};
}

async function setSettings(values) {
  const response = await chrome.runtime.sendMessage({ action: 'setSettings', values });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response?.settings || {};
}

if (isDetachedMode) {
  document.body.classList.add('detached');
}

if (isPipMode) {
  document.body.classList.add('pip');
}

function getDefaultVoice(provider) {
  return provider === PROVIDERS.OPENAI ? DEFAULT_OPENAI_VOICE : DEFAULT_GOOGLE_VOICE;
}

function getSelectedVoice(data, provider) {
  if (provider === PROVIDERS.OPENAI) {
    return data.openaiVoice || DEFAULT_OPENAI_VOICE;
  }

  return data.googleVoice || data.voice || DEFAULT_GOOGLE_VOICE;
}

function getSelectedApiKey(data, provider) {
  if (provider === PROVIDERS.OPENAI) {
    return data.openaiApiKey || '';
  }

  return data.googleApiKey || data.apiKey || '';
}

function renderVoiceOptions(provider, selectedVoice) {
  const voiceSelect = $('voice');
  voiceSelect.replaceChildren();

  for (const group of VOICE_OPTIONS[provider]) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;

    for (const [value, label] of group.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      optgroup.append(option);
    }

    voiceSelect.append(optgroup);
  }

  voiceSelect.value = selectedVoice;
  if (voiceSelect.value !== selectedVoice) {
    voiceSelect.value = getDefaultVoice(provider);
  }
}

function syncProviderUi(data) {
  $('provider').value = activeProvider;
  $('apiKeyLabel').textContent = activeProvider === PROVIDERS.OPENAI ? 'OpenAI API Key' : 'GCP API Key';
  $('apiKey').placeholder = activeProvider === PROVIDERS.OPENAI ? 'Enter your OpenAI API key' : 'Enter your API key';
  $('apiKey').value = getSelectedApiKey(data, activeProvider);
  renderVoiceOptions(activeProvider, getSelectedVoice(data, activeProvider));
  $('providerNote').hidden = activeProvider !== PROVIDERS.OPENAI;
}

// ── Load saved settings ──

getSettings().then(data => {
  activeProvider = data.provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE;
  syncProviderUi(data);
  if (data.speed) {
    $('speedSlider').value = data.speed;
    $('speedVal').textContent = parseFloat(data.speed).toFixed(1);
  }
}).catch(error => {
  $('status').textContent = '⚠ ' + error.message;
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
  const keyField = activeProvider === PROVIDERS.OPENAI ? 'openaiApiKey' : 'googleApiKey';
  await setSettings({ provider: activeProvider, [keyField]: key });

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
  setSettings({ speed: s }).catch(() => {});
  sendCommand({ action: 'setSpeed', speed: s }).catch(() => {});
});

// ── Settings ──

$('saveKey').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (key) {
    const keyField = activeProvider === PROVIDERS.OPENAI ? 'openaiApiKey' : 'googleApiKey';
    setSettings({ provider: activeProvider, [keyField]: key })
      .then(() => {
        $('status').textContent = '✓ API key saved';
      })
      .catch(error => {
        $('status').textContent = '⚠ ' + error.message;
      });
  }
});

$('provider').addEventListener('change', async e => {
  activeProvider = e.target.value === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE;
  const data = await getSettings();
  syncProviderUi(data);
  setSettings({ provider: activeProvider }).catch(error => {
    $('status').textContent = '⚠ ' + error.message;
  });
});

$('voice').addEventListener('change', e => {
  const field = activeProvider === PROVIDERS.OPENAI ? 'openaiVoice' : 'googleVoice';
  setSettings({ provider: activeProvider, [field]: e.target.value }).catch(error => {
    $('status').textContent = '⚠ ' + error.message;
  });
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
