import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const state = {
  playing: false,
  paused: false,
  audio: null,
  chunks: [],
  preparedAssets: new Map(),
  chunkIndex: 0,
  speed: 1.0,
  voice: 'ja-JP-Neural2-B',
  targetKey: null,
  targetTitle: ''
};

function getVoiceLanguageCode(voice) {
  const match = /^([a-z]{2,3})-[A-Z]{2}/.exec(voice || '');
  return match ? match[1] : 'ja';
}

function byteLen(text) {
  return new TextEncoder().encode(text).byteLength;
}

function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function targetKey(target) {
  return `${target.documentType || 'content'}|${target.sourceUrl || target.url || ''}`;
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongPiece(text, limitBytes) {
  if (byteLen(text) <= limitBytes) {
    return [text];
  }

  const sentenceParts = text
    .split(/(?<=[。！？.!?])\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (sentenceParts.length > 1) {
    return sentenceParts.flatMap(part => splitLongPiece(part, limitBytes));
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const pieces = [];
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && byteLen(next) > limitBytes) {
        pieces.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) {
      pieces.push(current);
    }
    return pieces.flatMap(part => splitLongPiece(part, limitBytes));
  }

  const chars = [...text];
  const pieces = [];
  let current = '';
  for (const char of chars) {
    const next = current + char;
    if (current && byteLen(next) > limitBytes) {
      pieces.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

function makeChunksFromText(text, limitBytes = 4800) {
  const speakOpen = '<speak>';
  const speakClose = '</speak>';
  const joiner = '<break time="300ms"/>';
  const chunks = [];
  const pieces = normalizeText(text)
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => splitLongPiece(part, 3600));

  let current = {
    text: '',
    parts: [],
    bytes: byteLen(speakOpen) + byteLen(speakClose)
  };

  for (const piece of pieces) {
    const escaped = escapeSsml(piece);
    const prefixBytes = current.parts.length > 0 ? byteLen(joiner) : 0;
    const pieceBytes = byteLen(escaped) + prefixBytes;

    if (current.parts.length > 0 && current.bytes + pieceBytes > limitBytes) {
      current.ssml = `${speakOpen}${current.parts.join(joiner)}${speakClose}`;
      current.memoryKey = `${state.voice}|${current.ssml}`;
      chunks.push(current);
      current = {
        text: '',
        parts: [],
        bytes: byteLen(speakOpen) + byteLen(speakClose)
      };
    }

    current.parts.push(escaped);
    current.text += `${current.text ? '\n\n' : ''}${piece}`;
    current.bytes += byteLen(escaped) + (current.parts.length > 1 ? byteLen(joiner) : 0);
  }

  if (current.parts.length > 0) {
    current.ssml = `${speakOpen}${current.parts.join(joiner)}${speakClose}`;
    current.memoryKey = `${state.voice}|${current.ssml}`;
    chunks.push(current);
  }

  return chunks;
}

async function extractPdfText(sourceUrl) {
  const response = await fetch(sourceUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to load PDF (${response.status})`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    let text = '';

    for (const item of textContent.items) {
      if (!('str' in item) || !item.str) {
        continue;
      }

      text += item.str;
      if (item.hasEOL) {
        text += '\n';
      }
    }

    text = normalizeText(text);

    if (text) {
      pages.push(text);
    }
  }

  if (pages.length === 0) {
    throw new Error('No readable text found in this PDF.');
  }

  return pages.join('\n\n');
}

async function extractTextDocument(sourceUrl) {
  const response = await fetch(sourceUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to load document (${response.status})`);
  }

  const text = normalizeText(await response.text());
  if (!text) {
    throw new Error('No readable text found in this document.');
  }

  return text;
}

async function getDocumentText(target) {
  if (target.documentType === 'pdf') {
    notify('loading', 'Loading PDF text…');
    return extractPdfText(target.sourceUrl);
  }

  notify('loading', 'Loading document text…');
  return extractTextDocument(target.sourceUrl);
}

function b64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let index = 0; index < bin.length; index++) {
    bytes[index] = bin.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'audio/mpeg' });
}

async function startReading(target) {
  stopReading(false);

  const prefs = await chrome.storage.sync.get(['voice', 'speed']);
  if (prefs.voice) state.voice = prefs.voice;
  if (prefs.speed) state.speed = prefs.speed;

  const text = await getDocumentText(target);
  const chunks = makeChunksFromText(text);
  if (chunks.length === 0) {
    throw new Error('No readable text found in this document.');
  }

  state.targetKey = targetKey(target);
  state.targetTitle = target.title || '';
  state.chunks = chunks;
  state.chunkIndex = 0;
  state.playing = true;
  state.paused = false;

  for (const chunk of chunks) {
    const cached = state.preparedAssets.get(chunk.memoryKey);
    if (cached) {
      chunk.audioContent = cached.audioContent;
      chunk.timepoints = cached.timepoints || [];
    }
  }

  const missingChunks = chunks.filter(chunk => !chunk.audioContent);
  if (missingChunks.length > 0) {
    notify('loading', `Synthesizing ${missingChunks.length} chunk(s)…`);
    const response = await chrome.runtime.sendMessage({
      action: 'synthesize',
      chunks: missingChunks.map((chunk, index) => ({
        text: chunk.text,
        ssml: chunk.ssml,
        index: chunks.indexOf(chunk) || index
      })),
      voice: state.voice,
      url: target.sourceUrl || target.url
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    for (const result of response.results || []) {
      const chunk = chunks[result.chunkIndex];
      if (!chunk) {
        continue;
      }

      chunk.audioContent = result.audioContent;
      chunk.timepoints = result.timepoints || [];
      state.preparedAssets.set(chunk.memoryKey, {
        audioContent: result.audioContent,
        timepoints: result.timepoints || []
      });
    }
  }

  notify('playing', `Reading ${target.documentType === 'pdf' ? 'PDF' : 'document'}…`);
  playNextChunk();
}

function playNextChunk() {
  if (!state.playing || state.chunkIndex >= state.chunks.length) {
    stopReading();
    return;
  }

  const chunk = state.chunks[state.chunkIndex];
  if (!chunk?.audioContent) {
    state.chunkIndex += 1;
    playNextChunk();
    return;
  }

  const objectUrl = URL.createObjectURL(b64ToBlob(chunk.audioContent));
  const audio = new Audio(objectUrl);
  audio.playbackRate = state.speed;
  state.audio = audio;

  audio.addEventListener('loadedmetadata', () => {
    audio.play().catch(error => {
      console.error('[TTS Reader] Offscreen audio play failed', error);
      URL.revokeObjectURL(objectUrl);
      stopReading();
      notify('error', 'Audio playback failed in the offscreen reader.');
    });
  }, { once: true });

  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(objectUrl);
    if (state.audio === audio) {
      state.audio = null;
    }
    state.chunkIndex += 1;
    playNextChunk();
  }, { once: true });

  audio.addEventListener('error', () => {
    URL.revokeObjectURL(objectUrl);
    if (state.audio === audio) {
      state.audio = null;
    }
    state.chunkIndex += 1;
    playNextChunk();
  }, { once: true });
}

function pauseReading() {
  if (!state.audio || !state.playing) {
    return;
  }

  if (state.paused) {
    state.paused = false;
    state.audio.play().catch(error => {
      console.error('[TTS Reader] Offscreen resume failed', error);
      notify('error', 'Failed to resume playback.');
    });
    notify('playing', 'Reading…');
    return;
  }

  state.paused = true;
  state.audio.pause();
  notify('paused', 'Paused');
}

function stopReading(notifyReady = true) {
  const wasPlaying = state.playing;
  state.playing = false;
  state.paused = false;
  state.chunkIndex = 0;
  state.chunks = [];
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  if (wasPlaying && notifyReady) {
    notify('ready', 'Ready');
  }
}

function setSpeed(speed) {
  state.speed = speed;
  if (state.audio) {
    state.audio.playbackRate = speed;
  }
}

function getState(target) {
  if (target && state.targetKey && targetKey(target) !== state.targetKey) {
    return {
      playing: false,
      paused: false,
      speed: state.speed
    };
  }

  return {
    playing: state.playing,
    paused: state.paused,
    speed: state.speed
  };
}

function notify(status, message) {
  chrome.runtime.sendMessage({ action: 'statusUpdate', status, message }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'offscreenCommand') {
    return false;
  }

  const command = async () => {
    switch (msg.command) {
      case 'read':
        await startReading(msg.target);
        return { ok: true };
      case 'pause':
        pauseReading();
        return { ok: true };
      case 'stop':
        stopReading();
        return { ok: true };
      case 'setSpeed':
        setSpeed(msg.speed);
        return { ok: true };
      case 'toggleRead':
        if (state.playing) {
          pauseReading();
        } else {
          await startReading(msg.target);
        }
        return { ok: true };
      case 'getState':
        return getState(msg.target);
      default:
        return { ok: true };
    }
  };

  command().then(sendResponse).catch(error => {
    notify('error', error.message);
    sendResponse({ error: error.message });
  });

  return true;
});