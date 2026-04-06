/* background.js — Service worker: GCP TTS API calls + IndexedDB caching */

const DB_NAME = 'tts_cache';
const DB_VER = 1;
const STORE = 'audio';
const DETACHED_CONTROLLER_URL = chrome.runtime.getURL('popup.html?detached=1');
const OFFSCREEN_DOCUMENT_URL = 'offscreen.html';
const PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const PDF_URL_RE = /\.pdf(?:$|[?#])/i;
const PDF_CONTENT_TYPE_RE = /^application\/pdf\b/i;
const TEXT_CONTENT_TYPE_RE = /^(?:text\/(?:plain|markdown|csv|tab-separated-values|xml)|application\/(?:json|xml|x-yaml|yaml))(?:;|$)/i;
const TEXT_DOCUMENT_URL_RE = /\.(?:txt|text|md|markdown|csv|tsv|log|json|xml|ya?ml|ini|cfg|conf|srt|vtt)(?:$|[?#])/i;
const PROVIDERS = {
  GOOGLE: 'google',
  OPENAI: 'openai'
};
const DEFAULT_GOOGLE_VOICE = 'ja-JP-Neural2-B';
const DEFAULT_OPENAI_VOICE = 'alloy';

let targetTabId = null;
let targetFrameId = null;
const sniffedDocumentCache = new Map();

function describeReadableUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'chrome-extension:' && url.hostname === PDF_VIEWER_EXTENSION_ID) {
      const sourceUrl = url.searchParams.get('src');
      if (sourceUrl) {
        return { mode: 'document', documentType: 'pdf', sourceUrl };
      }
    }

    if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
      return null;
    }

    if (PDF_URL_RE.test(rawUrl)) {
      return { mode: 'document', documentType: 'pdf', sourceUrl: url.toString() };
    }

    if (TEXT_DOCUMENT_URL_RE.test(rawUrl)) {
      return { mode: 'document', documentType: 'text', sourceUrl: url.toString() };
    }

    return { mode: 'content' };
  } catch {
    return null;
  }
}

function isSupportedUrl(url) {
  return Boolean(describeReadableUrl(url));
}

function describeReadableContentType(contentType, rawUrl) {
  const value = (contentType || '').split(';', 1)[0].trim();
  if (!value) {
    return null;
  }

  if (PDF_CONTENT_TYPE_RE.test(value)) {
    return { mode: 'document', documentType: 'pdf', sourceUrl: rawUrl };
  }

  if (TEXT_CONTENT_TYPE_RE.test(value)) {
    return { mode: 'document', documentType: 'text', sourceUrl: rawUrl };
  }

  return null;
}

async function sniffReadableDocument(rawUrl) {
  if (sniffedDocumentCache.has(rawUrl)) {
    return sniffedDocumentCache.get(rawUrl);
  }

  let details = null;

  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      sniffedDocumentCache.set(rawUrl, null);
      return null;
    }

    const response = await fetch(rawUrl, {
      method: 'HEAD',
      credentials: 'include',
      redirect: 'follow'
    });

    if (response.ok) {
      details = describeReadableContentType(response.headers.get('content-type'), rawUrl);
    }
  } catch {
    details = null;
  }

  sniffedDocumentCache.set(rawUrl, details);
  return details;
}

function buildTargetDescriptor(tab, frameId = null) {
  const details = describeReadableUrl(tab?.url);
  if (!tab?.id || !details) {
    return null;
  }

  return {
    tabId: tab.id,
    frameId,
    url: tab.url,
    title: tab.title,
    mode: details.mode,
    documentType: details.documentType || null,
    sourceUrl: details.sourceUrl || null
  };
}

async function buildResolvedTargetDescriptor(tab, frameId = null) {
  if (!tab?.id) {
    return null;
  }

  let details = describeReadableUrl(tab.url);
  if (!details) {
    return null;
  }

  if (details.mode === 'content') {
    const sniffed = await sniffReadableDocument(tab.url);
    if (sniffed) {
      details = sniffed;
    }
  }

  return {
    tabId: tab.id,
    frameId,
    url: tab.url,
    title: tab.title,
    mode: details.mode,
    documentType: details.documentType || null,
    sourceUrl: details.sourceUrl || null
  };
}

async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL)]
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play synthesized audio and extract text from PDFs outside the page DOM.'
  });
}

async function sendOffscreenCommand(command, payload = {}) {
  if (command === 'getState' && !(await hasOffscreenDocument())) {
    return { playing: false, paused: false, speed: payload.speed || 1.0 };
  }

  if ((command === 'pause' || command === 'stop' || command === 'setSpeed') && !(await hasOffscreenDocument())) {
    return { ok: true };
  }

  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    action: 'offscreenCommand',
    command,
    ...payload
  });
}

function getDefaultVoice(provider) {
  return provider === PROVIDERS.OPENAI ? DEFAULT_OPENAI_VOICE : DEFAULT_GOOGLE_VOICE;
}

function getSelectedVoice(settings, provider) {
  if (provider === PROVIDERS.OPENAI) {
    return settings.openaiVoice || DEFAULT_OPENAI_VOICE;
  }

  return settings.googleVoice || settings.voice || DEFAULT_GOOGLE_VOICE;
}

function getSelectedApiKey(settings, provider) {
  if (provider === PROVIDERS.OPENAI) {
    return settings.openaiApiKey || '';
  }

  return settings.googleApiKey || settings.apiKey || '';
}

async function getStoredSettings() {
  const storageArea = chrome.storage?.sync || chrome.storage?.local;
  if (!storageArea) {
    throw new Error('Extension storage is unavailable. Reload the extension and try again.');
  }

  return storageArea.get([
    'provider',
    'apiKey',
    'googleApiKey',
    'openaiApiKey',
    'voice',
    'googleVoice',
    'openaiVoice',
    'speed'
  ]);
}

async function setStoredSettings(values) {
  const storageArea = chrome.storage?.sync || chrome.storage?.local;
  if (!storageArea) {
    throw new Error('Extension storage is unavailable. Reload the extension and try again.');
  }

  await storageArea.set(values);
  return getStoredSettings();
}

function getVoiceLanguageCode(voice) {
  const match = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice || '');
  return match ? match[1] : 'ja-JP';
}

async function setTargetTab(tabId) {
  if (!tabId) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (buildTargetDescriptor(tab)) {
      targetTabId = tab.id;
      targetFrameId = null;
    }
  } catch {
    if (targetTabId === tabId) {
      targetTabId = null;
      targetFrameId = null;
    }
  }
}

async function setTargetFrame(tabId, frameId) {
  await setTargetTab(tabId);
  targetFrameId = typeof frameId === 'number' ? frameId : null;
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

async function resolveTargetTab() {
  if (targetTabId) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      const descriptor = await buildResolvedTargetDescriptor(tab, targetFrameId);
      if (descriptor) {
        return descriptor;
      }
    } catch {
      targetTabId = null;
      targetFrameId = null;
    }
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) {
    const descriptor = await buildResolvedTargetDescriptor(tab);
    if (descriptor) {
      targetTabId = tab.id;
      targetFrameId = null;
      return descriptor;
    }
  }

  return null;
}

async function openDetachedController(sourceTabId) {
  if (sourceTabId) {
    await setTargetTab(sourceTabId);
  }

  const matches = await chrome.tabs.query({ url: DETACHED_CONTROLLER_URL });
  const existing = matches[0];

  if (existing?.windowId) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (existing.id) {
      await chrome.tabs.update(existing.id, { active: true });
    }
    return { ok: true, reused: true };
  }

  await chrome.windows.create({
    url: DETACHED_CONTROLLER_URL,
    type: 'popup',
    width: 380,
    height: 360,
    focused: true
  });

  return { ok: true, reused: false };
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  setTargetTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete' && isSupportedUrl(tab.url)) {
    targetTabId = tabId;
    targetFrameId = null;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (targetTabId === tabId) {
    targetTabId = null;
    targetFrameId = null;
  }
});

// ── IndexedDB helpers ──

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbGet(db, key) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

function dbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Hashing ──

async function sha256(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── GCP TTS API ──

async function synthesize(ssml, apiKey, voice) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode: getVoiceLanguageCode(voice), name: voice },
        audioConfig: { audioEncoding: 'MP3' },
        enableTimePointing: ['SSML_MARK']
      })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `TTS API error (${res.status})`);
  }
  return res.json();
}

async function synthesizeOpenAI(input, apiKey, voice) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1',
      input,
      voice,
      response_format: 'mp3'
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI TTS error (${res.status})`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return {
    audioContent: btoa(binary),
    timepoints: []
  };
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'offscreenCommand') {
    return false;
  }

  if (msg.action === 'setTargetTab') {
    (typeof msg.frameId === 'number' ? setTargetFrame(msg.tabId, msg.frameId) : setTargetTab(msg.tabId))
      .then(() => sendResponse({ ok: true, tabId: targetTabId, frameId: targetFrameId }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'openDetachedController') {
    openDetachedController(msg.sourceTabId)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'getTargetTab') {
    resolveTargetTab()
      .then(tab => sendResponse(tab || { error: 'Open a readable page, text document, or PDF first.' }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'getSettings') {
    getStoredSettings()
      .then(settings => sendResponse({ settings }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'setSettings') {
    setStoredSettings(msg.values || {})
      .then(settings => sendResponse({ settings }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'documentReaderCommand') {
    sendOffscreenCommand(msg.command, {
      target: msg.target,
      speed: msg.speed,
      startWordIndex: msg.startWordIndex
    })
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'synthesize') {
    handleSynthesize(msg)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true; // async response
  }

  if (msg.action === 'clearCache') {
    indexedDB.deleteDatabase(DB_NAME);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleSynthesize({ chunks, provider, voice, url }) {
  const settings = await getStoredSettings();
  const activeProvider = provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : (settings.provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE);
  const activeVoice = voice || getSelectedVoice(settings, activeProvider) || getDefaultVoice(activeProvider);
  const apiKey = getSelectedApiKey(settings, activeProvider);

  if (!apiKey) {
    throw new Error(`${activeProvider === PROVIDERS.OPENAI ? 'OpenAI' : 'Google Cloud'} API key not configured. Click the extension icon to set it.`);
  }

  const db = await openDB();
  const results = [];

  for (const chunk of chunks) {
    const synthInput = chunk.ssml || chunk.input;
    const cacheKey = await sha256(`v4|${activeProvider}|${activeVoice}|${synthInput}`);

    const cached = await dbGet(db, cacheKey);
    if (cached?.audioContent) {
      results.push({
        audioContent: cached.audioContent,
        timepoints: cached.timepoints || [],
        chunkIndex: chunk.index,
        cached: true
      });
      continue;
    }

    const data = activeProvider === PROVIDERS.OPENAI
      ? await synthesizeOpenAI(chunk.input, apiKey, activeVoice)
      : await synthesize(chunk.ssml, apiKey, activeVoice);

    await dbPut(db, {
      key: cacheKey,
      audioContent: data.audioContent,
      timepoints: data.timepoints || [],
      provider: activeProvider,
      voice: activeVoice,
      url,
      ts: Date.now()
    });

    results.push({
      audioContent: data.audioContent,
      timepoints: data.timepoints || [],
      chunkIndex: chunk.index,
      cached: false
    });
  }

  return { results };
}

// ── Keyboard shortcut ──

chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-reading') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await setTargetTab(tab.id);
      const target = await resolveTargetTab();
      if (target?.tabId === tab.id && target.mode === 'document') {
        sendOffscreenCommand('toggleRead', {
          target: {
            tabId: target.tabId,
            url: target.url,
            title: target.title,
            mode: target.mode,
            documentType: target.documentType,
            sourceUrl: target.sourceUrl
          }
        }).catch(() => {});
        return;
      }

      const resolved = await resolveTargetTab();
      let frameId = resolved?.tabId === tab.id ? resolved.frameId ?? null : null;

      if (frameId === null) {
        frameId = await findSelectionFrameId(tab.id);
      }

      if (frameId !== null) {
        await setTargetFrame(tab.id, frameId);
        chrome.tabs.sendMessage(tab.id, { action: 'toggleRead' }, { frameId }).catch(() => {});
      } else {
        await setTargetTab(tab.id);
        chrome.tabs.sendMessage(tab.id, { action: 'toggleRead' }).catch(() => {});
      }
    }
  }
});
