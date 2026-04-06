/* background.js — Service worker: GCP TTS API calls + IndexedDB caching */

const DB_NAME = 'tts_cache';
const DB_VER = 1;
const STORE = 'audio';
const DETACHED_CONTROLLER_URL = chrome.runtime.getURL('popup.html?detached=1');
const OFFSCREEN_DOCUMENT_URL = 'offscreen.html';
const PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const PDF_URL_RE = /\.pdf(?:$|[?#])/i;
const TEXT_DOCUMENT_URL_RE = /\.(?:txt|text|md|markdown|csv|tsv|log|json|xml|ya?ml|ini|cfg|conf|srt|vtt)(?:$|[?#])/i;

let targetTabId = null;
let targetFrameId = null;

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
      const descriptor = buildTargetDescriptor(tab, targetFrameId);
      if (descriptor) {
        return descriptor;
      }
    } catch {
      targetTabId = null;
      targetFrameId = null;
    }
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallback = tabs.find(tab => buildTargetDescriptor(tab));
  if (fallback?.id) {
    const descriptor = buildTargetDescriptor(fallback);
    targetTabId = fallback.id;
    targetFrameId = null;
    return descriptor;
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

  if (msg.action === 'documentReaderCommand') {
    sendOffscreenCommand(msg.command, { target: msg.target, speed: msg.speed })
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
});

async function handleSynthesize({ chunks, voice, url }) {
  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) {
    throw new Error('API key not configured. Click the extension icon to set it.');
  }

  const db = await openDB();
  const results = [];

  for (const chunk of chunks) {
    const cacheKey = await sha256(`v3|${voice}|${chunk.ssml}`);

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

    const data = await synthesize(chunk.ssml, apiKey, voice);

    await dbPut(db, {
      key: cacheKey,
      audioContent: data.audioContent,
      timepoints: data.timepoints || [],
      voice,
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
