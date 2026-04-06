import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const state = {
  playing: false,
  paused: false,
  audio: null,
  chunks: [],
  preparedAssets: new Map(),
  chunkIndex: 0,
  readSessionId: 0,
  synthesisError: null,
  speed: 1.0,
  provider: 'google',
  voice: 'ja-JP-Neural2-B',
  targetKey: null,
  targetTitle: ''
};

const PROVIDERS = {
  GOOGLE: 'google',
  OPENAI: 'openai'
};

const DEFAULT_GOOGLE_VOICE = 'ja-JP-Neural2-B';
const DEFAULT_OPENAI_VOICE = 'alloy';

function getVoiceLanguageCode(voice) {
  const match = /^([a-z]{2,3})-[A-Z]{2}/.exec(voice || '');
  return match ? match[1] : 'ja';
}

function getSelectedVoice(prefs, provider) {
  if (provider === PROVIDERS.OPENAI) {
    return prefs.openaiVoice || DEFAULT_OPENAI_VOICE;
  }

  return prefs.googleVoice || prefs.voice || DEFAULT_GOOGLE_VOICE;
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

function makeGoogleChunksFromText(text, limitBytes = 4800) {
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

function makeOpenAIChunksFromText(text, limitChars = 3800) {
  const chunks = [];
  const pieces = normalizeText(text)
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean);

  let current = '';

  for (const piece of pieces) {
    if (!current && piece.length > limitChars) {
      const subPieces = splitLongPiece(piece, Math.min(limitChars, 3000));
      for (const subPiece of subPieces) {
        chunks.push({
          text: subPiece,
          input: subPiece,
          memoryKey: `${state.provider}|${state.voice}|${subPiece}`
        });
      }
      continue;
    }

    const next = current ? `${current}\n\n${piece}` : piece;
    if (current && next.length > limitChars) {
      chunks.push({
        text: current,
        input: current,
        memoryKey: `${state.provider}|${state.voice}|${current}`
      });
      if (piece.length > limitChars) {
        const subPieces = splitLongPiece(piece, Math.min(limitChars, 3000));
        for (const subPiece of subPieces) {
          chunks.push({
            text: subPiece,
            input: subPiece,
            memoryKey: `${state.provider}|${state.voice}|${subPiece}`
          });
        }
        current = '';
      } else {
        current = piece;
      }
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push({
      text: current,
      input: current,
      memoryKey: `${state.provider}|${state.voice}|${current}`
    });
  }

  return chunks;
}

function makeChunksFromText(text) {
  return state.provider === PROVIDERS.OPENAI ? makeOpenAIChunksFromText(text) : makeGoogleChunksFromText(text);
}

async function extractPdfText(sourceUrl) {
  const response = await fetch(sourceUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to load PDF (${response.status})`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
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

async function getSettings() {
  const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response?.settings || {};
}

async function synthesizeChunk(chunk, chunkIndex, url, sessionId) {
  if (!state.playing || state.readSessionId !== sessionId || chunk.audioContent) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    action: 'synthesize',
    chunks: [{
      text: chunk.text,
      input: chunk.input,
      ssml: chunk.ssml,
      index: chunkIndex
    }],
    provider: state.provider,
    voice: state.voice,
    url
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  if (!state.playing || state.readSessionId !== sessionId) {
    return;
  }

  const result = response.results?.[0];
  if (!result?.audioContent) {
    throw new Error('No audio returned from the TTS provider.');
  }

  chunk.audioContent = result.audioContent;
  chunk.timepoints = result.timepoints || [];
  state.preparedAssets.set(chunk.memoryKey, {
    audioContent: result.audioContent,
    timepoints: result.timepoints || []
  });
}

async function prefetchChunks(chunks, url, sessionId, startIndex) {
  for (let chunkIndex = startIndex; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    if (!chunk || chunk.audioContent) {
      continue;
    }

    try {
      await synthesizeChunk(chunk, chunkIndex, url, sessionId);
    } catch (error) {
      if (state.playing && state.readSessionId === sessionId) {
        state.synthesisError = error;
        notify('error', error.message);
      }
      return;
    }
  }
}

function waitForChunk(chunkIndex, sessionId) {
  if (!state.playing || state.readSessionId !== sessionId || state.chunkIndex !== chunkIndex) {
    return;
  }

  if (state.synthesisError) {
    const error = state.synthesisError;
    stopReading(false);
    notify('error', error.message);
    return;
  }

  if (state.chunks[chunkIndex]?.audioContent) {
    playNextChunk();
    return;
  }

  notify('loading', 'Preparing audio…');
  setTimeout(() => waitForChunk(chunkIndex, sessionId), 150);
}

async function startReading(target) {
  stopReading(false);
  const sessionId = state.readSessionId;

  const prefs = await getSettings();
  state.provider = prefs.provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE;
  state.voice = getSelectedVoice(prefs, state.provider);
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
  state.synthesisError = null;

  for (const chunk of chunks) {
    const cached = state.preparedAssets.get(chunk.memoryKey);
    if (cached) {
      chunk.audioContent = cached.audioContent;
      chunk.timepoints = cached.timepoints || [];
    }
  }

  const firstChunk = chunks[0];
  if (!firstChunk?.audioContent) {
    notify('loading', 'Synthesizing audio…');
    await synthesizeChunk(firstChunk, 0, target.sourceUrl || target.url, sessionId);
  }

  if (!state.playing || state.readSessionId !== sessionId) {
    return;
  }

  notify('playing', `Reading ${target.documentType === 'pdf' ? 'PDF' : 'document'}…`);
  playNextChunk();
  void prefetchChunks(chunks, target.sourceUrl || target.url, sessionId, 1);
}

function playNextChunk() {
  if (!state.playing || state.chunkIndex >= state.chunks.length) {
    stopReading();
    return;
  }

  const chunk = state.chunks[state.chunkIndex];
  if (!chunk?.audioContent) {
    waitForChunk(state.chunkIndex, state.readSessionId);
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
  state.readSessionId += 1;
  state.playing = false;
  state.paused = false;
  state.chunkIndex = 0;
  state.chunks = [];
  state.synthesisError = null;
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
        startReading(msg.target).catch(error => notify('error', error.message));
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
          startReading(msg.target).catch(error => notify('error', error.message));
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