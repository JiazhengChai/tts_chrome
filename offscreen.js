import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const state = {
  playing: false,
  paused: false,
  audio: null,
  chunks: [],
  preparedAssets: new Map(),
  chunkIndex: 0,
  startChunkIndex: 0,
  startWordIndex: 0,
  readSessionId: 0,
  rafId: null,
  activeWordIndex: null,
  synthesisError: null,
  speed: 1.0,
  provider: 'google',
  voice: 'ja-JP-Neural2-B',
  targetKey: null,
  targetTitle: '',
  documentModel: null
};

const PROVIDERS = {
  GOOGLE: 'google',
  OPENAI: 'openai'
};

const DEFAULT_GOOGLE_VOICE = 'ja-JP-Neural2-B';
const DEFAULT_OPENAI_VOICE = 'alloy';
const documentModelCache = new Map();
const documentSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

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

const PDF_CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const PDF_SOFT_HYPHEN_RE = /(?:\u00ad|[-\u2010\u2011])$/;

function isPdfCjkChar(char) {
  return Boolean(char) && PDF_CJK_CHAR_RE.test(char);
}

function shouldAddPdfTextGap(leftText, rightText) {
  if (!leftText || !rightText) {
    return false;
  }

  if (/\s$/.test(leftText) || /^\s/.test(rightText)) {
    return false;
  }

  const leftChar = leftText[leftText.length - 1];
  const rightChar = rightText[0];

  if (!leftChar || !rightChar) {
    return false;
  }

  if (/[([{"'“‘]$/.test(leftText) || /^[)\]}"'“”‘’.,!?;:%]/.test(rightText)) {
    return false;
  }

  if (isPdfCjkChar(leftChar) && isPdfCjkChar(rightChar)) {
    return false;
  }

  return true;
}

function getPdfItemLayout(item) {
  const [scaleX, skewY, skewX, scaleY, x, y] = item.transform;
  const fontSize = Math.max(
    Math.hypot(scaleX, skewY),
    Math.hypot(skewX, scaleY),
    Math.abs(item.height || 0),
    1
  );
  const horizontal = Math.abs(scaleX) >= Math.abs(skewY);
  const startCoord = horizontal ? x : y;
  const endCoord = startCoord + Math.abs(horizontal ? item.width || 0 : item.height || fontSize);
  const lineCoord = horizontal ? y : x;

  return {
    text: item.str,
    fontSize,
    horizontal,
    startCoord,
    endCoord,
    lineCoord
  };
}

function isPdfLineBreak(previousLayout, currentLayout) {
  if (!previousLayout) {
    return false;
  }

  const lineThreshold = Math.max(Math.min(previousLayout.fontSize, currentLayout.fontSize) * 0.6, 2);
  return Math.abs(currentLayout.lineCoord - previousLayout.lineCoord) > lineThreshold
    || currentLayout.startCoord + lineThreshold < previousLayout.startCoord;
}

function shouldInsertPdfSpace(previousLayout, currentText) {
  if (!previousLayout || !currentText) {
    return false;
  }

  if (!shouldAddPdfTextGap(previousLayout.text, currentText)) {
    return false;
  }

  const gap = currentText ? Math.max(0, previousLayout.nextStartCoord - previousLayout.endCoord) : 0;
  const gapThreshold = Math.max(previousLayout.fontSize * 0.12, 1.5);
  return gap > gapThreshold;
}

function appendPdfLine(lines, text, layout) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return;
  }

  lines.push({
    text: normalized,
    lineCoord: layout?.lineCoord ?? NaN,
    fontSize: layout?.fontSize ?? 0
  });
}

function mergePdfLines(lines) {
  let output = '';
  let previousLine = null;

  for (const line of lines) {
    if (!previousLine) {
      output = line.text;
      previousLine = line;
      continue;
    }

    const lineGap = Math.abs(line.lineCoord - previousLine.lineCoord);
    const paragraphBreak = Number.isFinite(lineGap)
      && lineGap > Math.max(Math.max(previousLine.fontSize, line.fontSize) * 1.2, 12);

    if (paragraphBreak) {
      output += `\n\n${line.text}`;
    } else if (PDF_SOFT_HYPHEN_RE.test(output) && /^[A-Za-z]/.test(line.text)) {
      output = `${output.slice(0, -1)}${line.text}`;
    } else if (shouldAddPdfTextGap(previousLine.text, line.text)) {
      output += ` ${line.text}`;
    } else {
      output += line.text;
    }

    previousLine = line;
  }

  return normalizeText(output);
}

async function extractPdfPageText(page) {
  const textContent = await page.getTextContent({ normalizeWhitespace: true });
  const lines = [];
  let lineText = '';
  let previousLayout = null;

  for (const item of textContent.items) {
    if (!('str' in item) || !item.str) {
      continue;
    }

    const text = item.str.replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }

    const layout = getPdfItemLayout(item);
    layout.text = text;
    layout.nextStartCoord = layout.startCoord;

    if (isPdfLineBreak(previousLayout, layout)) {
      appendPdfLine(lines, lineText, previousLayout);
      lineText = '';
    }

    if (lineText && previousLayout) {
      previousLayout.nextStartCoord = layout.startCoord;
      if (shouldInsertPdfSpace(previousLayout, text)) {
        lineText += ' ';
      }
    }

    lineText += text;
    previousLayout = layout;

    if (item.hasEOL) {
      appendPdfLine(lines, lineText, previousLayout);
      lineText = '';
      previousLayout = null;
    }
  }

  appendPdfLine(lines, lineText, previousLayout);
  return mergePdfLines(lines);
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

function buildDocumentModel(text) {
  const normalized = normalizeText(text);
  const paragraphs = [];
  const tokens = [];
  let globalIndex = 0;

  const rawParagraphs = normalized.split(/\n{2,}/).filter(Boolean);

  for (let paragraphIndex = 0; paragraphIndex < rawParagraphs.length; paragraphIndex++) {
    const paragraphText = rawParagraphs[paragraphIndex];
    const paragraph = [];

    for (const segment of documentSegmenter.segment(paragraphText)) {
      if (!segment.segment) {
        continue;
      }

      const token = {
        text: segment.segment,
        isWordLike: Boolean(segment.isWordLike),
        globalIndex
      };

      tokens.push(token);
      paragraph.push({
        text: token.text,
        isWordLike: token.isWordLike,
        globalIndex: token.globalIndex
      });
      globalIndex += 1;
    }

    if (paragraph.length) {
      paragraphs.push(paragraph);
    }

    if (paragraph.length && paragraphIndex < rawParagraphs.length - 1) {
      tokens.push({
        text: '\n\n',
        isWordLike: false,
        isParagraphBreak: true,
        globalIndex: globalIndex++
      });
    }
  }

  return {
    text: normalized,
    paragraphs,
    tokens
  };
}

function serializeDocumentPreview(model, key, target) {
  return {
    targetKey: key,
    title: target.title || '',
    documentType: target.documentType || 'document',
    paragraphs: model.paragraphs
  };
}

function makeGoogleChunksFromTokens(tokens, limitBytes = 4800) {
  const speakOpen = '<speak>';
  const speakClose = '</speak>';
  const chunks = [];
  let markIndex = 0;

  let current = {
    text: '',
    words: [],
    parts: [],
    bytes: byteLen(speakOpen) + byteLen(speakClose)
  };

  for (const token of tokens) {
    const markName = token.isWordLike ? `w${markIndex++}` : null;
    const markup = token.isParagraphBreak
      ? '<break time="400ms"/>'
      : (markName ? `<mark name="${markName}"/>${escapeSsml(token.text)}` : escapeSsml(token.text));
    const markupBytes = byteLen(markup);

    if (current.parts.length > 0 && current.bytes + markupBytes > limitBytes) {
      current.ssml = `${speakOpen}${current.parts.join('')}${speakClose}`;
      current.memoryKey = `${state.voice}|${current.ssml}`;
      chunks.push(current);
      current = {
        text: '',
        words: [],
        parts: [],
        bytes: byteLen(speakOpen) + byteLen(speakClose)
      };
    }

    current.parts.push(markup);
    current.words.push({ ...token, markName });
    current.text += token.text;
    current.bytes += markupBytes;
  }

  if (current.parts.length > 0) {
    current.ssml = `${speakOpen}${current.parts.join('')}${speakClose}`;
    current.memoryKey = `${state.voice}|${current.ssml}`;
    chunks.push(current);
  }

  return chunks;
}

function makeOpenAIChunksFromTokens(tokens, limitChars = 3800) {
  const chunks = [];
  let current = {
    text: '',
    input: '',
    words: []
  };

  for (const token of tokens) {
    const nextInput = current.input + token.text;
    if (current.input && nextInput.length > limitChars) {
      chunks.push({
        ...current,
        memoryKey: `${state.provider}|${state.voice}|${current.input}`
      });
      current = {
        text: '',
        input: '',
        words: []
      };
    }

    current.text += token.text;
    current.input += token.text;
    current.words.push({ ...token });
  }

  if (current.input) {
    chunks.push({
      ...current,
      memoryKey: `${state.provider}|${state.voice}|${current.input}`
    });
  }

  return chunks;
}

function makeChunksFromDocument(model) {
  return state.provider === PROVIDERS.OPENAI
    ? makeOpenAIChunksFromTokens(model.tokens)
    : makeGoogleChunksFromTokens(model.tokens);
}

function hasWordTimings(chunk) {
  return chunk.words?.some(word => typeof word.startTime === 'number');
}

function findPlaybackStart(chunks, startWordIndex) {
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const wordIndex = chunks[chunkIndex].words.findIndex(word => word.globalIndex >= startWordIndex);
    if (wordIndex !== -1) {
      return { chunkIndex, wordIndex };
    }
  }

  return { chunkIndex: 0, wordIndex: 0 };
}

function findSeekTime(chunk, startWordIndex) {
  const startWord = chunk.words.find(word => word.globalIndex >= startWordIndex && typeof word.startTime === 'number');
  return startWord ? Math.max(0, startWord.startTime) : 0;
}

function applyTimepoints(chunk, duration) {
  const marks = chunk.words.filter(word => word.markName);
  const starts = new Map((chunk.timepoints || []).map(timepoint => [timepoint.markName, timepoint.timeSeconds]));

  for (let index = 0; index < marks.length; index++) {
    const word = marks[index];
    const startTime = starts.get(word.markName);
    const nextStart = index + 1 < marks.length ? starts.get(marks[index + 1].markName) : duration;

    if (typeof startTime !== 'number') {
      continue;
    }

    word.startTime = startTime;
    word.endTime = typeof nextStart === 'number' && nextStart > startTime
      ? nextStart
      : Math.min(duration, startTime + 0.35);
  }
}

function estimateWordWeight(word) {
  const text = (word.text || '').trim();
  if (!text) {
    return 0.15;
  }

  if (word.isParagraphBreak) {
    return 0.8;
  }

  if (!word.isWordLike) {
    return Math.min(0.35, Math.max(0.12, text.length * 0.08));
  }

  return Math.max(0.2, text.length);
}

function applyEstimatedTimepoints(chunk, duration) {
  const words = chunk.words || [];
  if (!words.length || !(duration > 0)) {
    return;
  }

  const weights = words.map(estimateWordWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || words.length;
  let elapsed = 0;

  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const span = duration * (weights[index] / totalWeight);
    word.startTime = elapsed;
    word.endTime = index === words.length - 1 ? duration : Math.min(duration, elapsed + span);
    elapsed = word.endTime;
  }
}

function emitDocumentHighlight(activeWordIndex = null) {
  chrome.runtime.sendMessage({
    action: 'documentHighlightUpdate',
    targetKey: state.targetKey,
    activeWordIndex
  }).catch(() => {});
}

function applyDocumentHighlight(word) {
  if (!word || state.activeWordIndex === word.globalIndex) {
    return;
  }

  state.activeWordIndex = word.globalIndex;
  emitDocumentHighlight(word.globalIndex);
}

function clearDocumentHighlight() {
  cancelAnimationFrame(state.rafId);
  state.rafId = null;

  if (state.activeWordIndex === null) {
    return;
  }

  state.activeWordIndex = null;
  emitDocumentHighlight(null);
}

function runHighlightLoop(chunk) {
  const timedWords = chunk.words.filter(word => typeof word.startTime === 'number');

  const step = () => {
    if (!state.playing || state.paused || !state.audio) {
      return;
    }

    const currentTime = state.audio.currentTime;
    for (const word of timedWords) {
      if (currentTime >= word.startTime && currentTime < word.endTime) {
        applyDocumentHighlight(word);
        break;
      }
    }

    state.rafId = requestAnimationFrame(step);
  };

  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(step);
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
    const text = await extractPdfPageText(page);
    page.cleanup?.();

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

async function getDocumentText(target, { notifyProgress = true } = {}) {
  if (target.documentType === 'pdf') {
    if (notifyProgress) {
      notify('loading', 'Loading PDF text…');
    }
    return extractPdfText(target.sourceUrl);
  }

  if (notifyProgress) {
    notify('loading', 'Loading document text…');
  }
  return extractTextDocument(target.sourceUrl);
}

async function getDocumentModel(target, { notifyProgress = false } = {}) {
  const key = targetKey(target);
  const cached = documentModelCache.get(key);
  if (cached) {
    return cached;
  }

  const text = await getDocumentText(target, { notifyProgress });
  const model = buildDocumentModel(text);
  const entry = {
    key,
    target,
    ...model
  };

  documentModelCache.set(key, entry);
  return entry;
}

async function getDocumentPreview(target) {
  const model = await getDocumentModel(target);
  return serializeDocumentPreview(model, model.key, target);
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

async function startReading(target, startWordIndex = 0) {
  stopReading(false);
  const sessionId = state.readSessionId;

  const prefs = await getSettings();
  state.provider = prefs.provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE;
  state.voice = getSelectedVoice(prefs, state.provider);
  if (prefs.speed) state.speed = prefs.speed;

  const model = await getDocumentModel(target, { notifyProgress: true });
  const chunks = makeChunksFromDocument(model);
  if (chunks.length === 0) {
    throw new Error('No readable text found in this document.');
  }

  const playbackStart = findPlaybackStart(chunks, startWordIndex);

  state.targetKey = targetKey(target);
  state.targetTitle = target.title || '';
  state.documentModel = model;
  state.chunks = chunks;
  state.chunkIndex = playbackStart.chunkIndex;
  state.startChunkIndex = playbackStart.chunkIndex;
  state.startWordIndex = startWordIndex;
  state.playing = true;
  state.paused = false;
  state.activeWordIndex = null;
  state.synthesisError = null;

  for (const chunk of chunks) {
    const cached = state.preparedAssets.get(chunk.memoryKey);
    if (cached) {
      chunk.audioContent = cached.audioContent;
      chunk.timepoints = cached.timepoints || [];
    }
  }

  const firstChunk = chunks[playbackStart.chunkIndex];
  if (!firstChunk?.audioContent) {
    notify('loading', 'Synthesizing audio…');
    await synthesizeChunk(firstChunk, playbackStart.chunkIndex, target.sourceUrl || target.url, sessionId);
  }

  if (!state.playing || state.readSessionId !== sessionId) {
    return;
  }

  notify('playing', `Reading ${target.documentType === 'pdf' ? 'PDF' : 'document'}…`);
  playNextChunk();
  void prefetchChunks(chunks, target.sourceUrl || target.url, sessionId, playbackStart.chunkIndex + 1);
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
    if (chunk.timepoints?.length) {
      applyTimepoints(chunk, audio.duration);
    } else if (!hasWordTimings(chunk)) {
      applyEstimatedTimepoints(chunk, audio.duration);
    }

    if (hasWordTimings(chunk) && state.chunkIndex === state.startChunkIndex) {
      audio.currentTime = findSeekTime(chunk, state.startWordIndex);
    }

    audio.play().catch(error => {
      console.error('[TTS Reader] Offscreen audio play failed', error);
      URL.revokeObjectURL(objectUrl);
      stopReading();
      notify('error', 'Audio playback failed in the offscreen reader.');
    });

    if (hasWordTimings(chunk)) {
      runHighlightLoop(chunk);
    } else {
      clearDocumentHighlight();
    }
  }, { once: true });

  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(objectUrl);
    if (state.audio === audio) {
      state.audio = null;
    }
    clearDocumentHighlight();
    state.chunkIndex += 1;
    playNextChunk();
  }, { once: true });

  audio.addEventListener('error', () => {
    URL.revokeObjectURL(objectUrl);
    if (state.audio === audio) {
      state.audio = null;
    }
    clearDocumentHighlight();
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
    if (hasWordTimings(state.chunks[state.chunkIndex])) {
      runHighlightLoop(state.chunks[state.chunkIndex]);
    }
    notify('playing', 'Reading…');
    return;
  }

  state.paused = true;
  state.audio.pause();
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
  notify('paused', 'Paused');
}

function stopReading(notifyReady = true) {
  const wasPlaying = state.playing;
  state.readSessionId += 1;
  state.playing = false;
  state.paused = false;
  state.chunkIndex = 0;
  state.startChunkIndex = 0;
  state.startWordIndex = 0;
  state.chunks = [];
  state.documentModel = null;
  state.synthesisError = null;
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  clearDocumentHighlight();
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
      speed: state.speed,
      activeWordIndex: null,
      targetKey: targetKey(target)
    };
  }

  return {
    playing: state.playing,
    paused: state.paused,
    speed: state.speed,
    activeWordIndex: state.activeWordIndex,
    targetKey: state.targetKey
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
        startReading(msg.target, Math.max(0, msg.startWordIndex || 0)).catch(error => notify('error', error.message));
        return { ok: true };
      case 'getPreview':
        return getDocumentPreview(msg.target);
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
          startReading(msg.target, Math.max(0, msg.startWordIndex || 0)).catch(error => notify('error', error.message));
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