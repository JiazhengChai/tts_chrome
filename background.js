/* background.js — Service worker: GCP TTS API calls + IndexedDB caching */

const DB_NAME = 'tts_cache';
const DB_VER = 1;
const STORE = 'audio';

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

async function synthesize(text, apiKey, voice) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.slice(0, 5), name: voice },
        audioConfig: { audioEncoding: 'MP3' }
      })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `TTS API error (${res.status})`);
  }
  return res.json(); // { audioContent: "base64..." }
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    const cacheKey = await sha256(chunk.text + '|' + voice);

    // Check cache
    const cached = await dbGet(db, cacheKey);
    if (cached) {
      results.push({ audioContent: cached.audioContent, chunkIndex: chunk.index });
      continue;
    }

    // Call API
    const data = await synthesize(chunk.text, apiKey, voice);

    // Store in cache
    await dbPut(db, {
      key: cacheKey,
      audioContent: data.audioContent,
      voice,
      url,
      ts: Date.now()
    });

    results.push({ audioContent: data.audioContent, chunkIndex: chunk.index });
  }

  return { results };
}

// ── Keyboard shortcut ──

chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-reading') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'toggleRead' });
    }
  }
});
