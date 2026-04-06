/* content.js — Injected into every page.
   Handles text extraction, word segmentation, audio playback,
   and word-level highlighting via the CSS Custom Highlight API. */

(() => {
  if (window.__ttsReaderLoaded) return;
  window.__ttsReaderLoaded = true;

  // ═══════════════════ State ═══════════════════

  const state = {
    playing: false,
    paused: false,
    audio: null,
    chunks: [],       // [{ text, words, audioContent }]
    preparedKey: null,
    preparedAssets: new Map(),
    chunkIndex: 0,
    startChunkIndex: 0,
    startWordIndex: 0,
    rafId: null,
    activeWordKey: null,
    readSessionId: 0,
    synthesisError: null,
    speed: 1.0,
    provider: 'google',
    voice: 'ja-JP-Neural2-B',
    segmentLanguage: 'ja'
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

  function resolvePageLanguage() {
    const lang = document.documentElement?.lang || navigator.language || 'ja';
    return lang.split('-')[0] || 'ja';
  }

  function resolveSegmentLanguage(provider, voice) {
    return provider === PROVIDERS.OPENAI ? resolvePageLanguage() : getVoiceLanguageCode(voice);
  }

  function getSelectedVoice(prefs, provider) {
    if (provider === PROVIDERS.OPENAI) {
      return prefs.openaiVoice || DEFAULT_OPENAI_VOICE;
    }

    return prefs.googleVoice || prefs.voice || DEFAULT_GOOGLE_VOICE;
  }

  // ═══════════════════ Selection caching ═══════════════════

  let cachedSelection = null;

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      try {
        cachedSelection = {
          range: sel.getRangeAt(0).cloneRange(),
          ts: Date.now()
        };
      } catch { /* ignore */ }
    }
  });

  function isGoogleDocs() {
    return location.hostname === 'docs.google.com' && /\/document\//.test(location.pathname);
  }

  // ═══════════════════ CSS Custom Highlight ═══════════════════

  let wordHL = null;
  try {
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      wordHL = new Highlight();
      CSS.highlights.set('tts-word', wordHL);
    }
  } catch { /* older Chrome */ }

  // ═══════════════════ DOM helpers ═══════════════════

  const BLOCK_TAGS = new Set([
    'P','DIV','SECTION','ARTICLE','MAIN','BODY','LI','OL','UL',
    'H1','H2','H3','H4','H5','H6','BLOCKQUOTE','TD','TH','FIGCAPTION','DETAILS'
  ]);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','TEXTAREA','INPUT','SELECT','CANVAS','VIDEO','AUDIO']);

  function isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  /** Heuristic: find the element most likely to be the article body. */
  function findArticle() {
    // Google Docs: target the editor content area
    if (isGoogleDocs()) {
      const gdocSelectors = [
        '.kix-appview-editor',
        '.kix-paginateddocumentplugin',
        '.kix-page-content-wrapper'
      ];
      for (const sel of gdocSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 50) return el;
      }
    }

    const candidates = [
      'article', '[role="main"]', 'main',
      '.article-body', '.entry-content', '.post-content',
      '.article__body', '#article-body', '.story-body',
      '#content', '.content'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) return el;
    }
    // Fallback: largest block child of body
    let best = document.body;
    for (const child of document.body.children) {
      if (child.textContent.trim().length > best.textContent.trim().length * 0.5 &&
          child.textContent.trim().length > 200) {
        best = child;
      }
    }
    return best;
  }

  /** Collect visible text nodes under `root` in document order. */
  function textNodesUnder(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !isVisible(p)) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // ═══════════════════ Word extraction ═══════════════════

  function extractWords() {
    const sel = window.getSelection();
    let hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
    let activeRange = null;

    if (hasSelection) {
      activeRange = sel.getRangeAt(0);
    } else if (cachedSelection && (Date.now() - cachedSelection.ts) < 30000) {
      // Use cached selection (e.g. cleared when popup opened)
      try {
        cachedSelection.range.getBoundingClientRect(); // verify still valid
        hasSelection = true;
        activeRange = cachedSelection.range;
      } catch { /* range invalidated by DOM change */ }
    }
    cachedSelection = null; // consume

    // Determine reading root
    let root = findArticle();
    if (hasSelection && activeRange) {
      // Make sure we use a container that includes the selection
      const selNode = activeRange.startContainer;
      if (!root.contains(selNode)) {
        let container = selNode.nodeType === Node.TEXT_NODE ? selNode.parentElement : selNode;
        while (container && container !== document.body && !BLOCK_TAGS.has(container.tagName)) {
          container = container.parentElement;
        }
        root = container || document.body;
      }
    }

    const nodes = textNodesUnder(root);
    const segmenter = new Intl.Segmenter(state.segmentLanguage, { granularity: 'word' });
    const words = [];

    const selRange = hasSelection ? activeRange : null;
    const selPoint = (hasSelection && selRange) ? document.createRange() : null;
    let startWordIndex = 0;
    let foundStart = !hasSelection;

    if (selPoint) {
      try {
        selPoint.setStart(selRange.startContainer, selRange.startOffset);
        selPoint.collapse(true);
      } catch { foundStart = true; /* invalid range, skip selection matching */ }
    }

    for (const node of nodes) {
      for (const seg of segmenter.segment(node.textContent)) {
        const word = pushWord(words, node, seg);
        if (!word || foundStart || !selPoint) continue;

        // First segment whose end falls after the selection start.
        if (word.range.compareBoundaryPoints(Range.END_TO_START, selPoint) > 0) {
          startWordIndex = word.globalIndex;
          foundStart = true;
        }
      }
    }

    // Google Docs fallback: start from first word visible in viewport
    if (!hasSelection && isGoogleDocs() && words.length > 0) {
      for (let i = 0; i < words.length; i++) {
        try {
          const rect = words[i].range.getBoundingClientRect();
          if (rect.bottom > 0 && rect.top < window.innerHeight) {
            startWordIndex = i;
            break;
          }
        } catch { /* skip */ }
      }
    }

    return {
      words,
      startWordIndex: words.length > 0 ? Math.min(startWordIndex, words.length - 1) : 0
    };
  }

  function pushWord(words, node, seg) {
    try {
      const r = document.createRange();
      r.setStart(node, seg.index);
      r.setEnd(node, seg.index + seg.segment.length);
      const word = {
        text: seg.segment,
        isWordLike: seg.isWordLike,
        range: r,
        globalIndex: words.length
      };
      words.push(word);
      return word;
    } catch { /* invalid offset — skip */ }
    return null;
  }

  // ═══════════════════ Chunking ═══════════════════

  /** UTF-8 byte length of a string. */
  function byteLen(s) {
    return new TextEncoder().encode(s).byteLength;
  }

  function escapeSsml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** Split words into chunks whose text stays under `limit` UTF-8 bytes.
   *  GCP TTS hard-limits SSML input to 5000 bytes; we use 4700 for safety. */
  function makeGoogleChunks(words, limitBytes = 4800) {
    const speakOpen = '<speak>';
    const speakClose = '</speak>';
    const chunks = [];
    let markIndex = 0;
    let buf = {
      text: '',
      words: [],
      parts: [],
      bytes: byteLen(speakOpen) + byteLen(speakClose)
    };

    for (const w of words) {
      const markName = w.isWordLike ? `w${markIndex++}` : null;
      const escaped = escapeSsml(w.text);
      const markup = markName ? `<mark name="${markName}"/>${escaped}` : escaped;
      const markupBytes = byteLen(markup);

      if (buf.bytes + markupBytes > limitBytes && buf.text.length > 0) {
        buf.ssml = `${speakOpen}${buf.parts.join('')}${speakClose}`;
        buf.memoryKey = `${state.voice}|${buf.ssml}`;
        chunks.push(buf);
        buf = {
          text: '',
          words: [],
          parts: [],
          bytes: byteLen(speakOpen) + byteLen(speakClose)
        };
      }

      const chunkWord = { ...w, markName };
      buf.text += w.text;
      buf.words.push(chunkWord);
      buf.parts.push(markup);
      buf.bytes += markupBytes;
    }

    if (buf.text.length > 0) {
      buf.ssml = `${speakOpen}${buf.parts.join('')}${speakClose}`;
      buf.memoryKey = `${state.voice}|${buf.ssml}`;
      chunks.push(buf);
    }

    return chunks;
  }

  function makeOpenAIChunks(words, limitChars = 3800) {
    const chunks = [];
    let current = {
      text: '',
      words: [],
      input: ''
    };

    for (const word of words) {
      const nextInput = current.input + word.text;
      if (current.input && nextInput.length > limitChars) {
        current.memoryKey = `${state.provider}|${state.voice}|${current.input}`;
        chunks.push(current);
        current = {
          text: '',
          words: [],
          input: ''
        };
      }

      current.text += word.text;
      current.words.push(word);
      current.input += word.text;
    }

    if (current.input) {
      current.memoryKey = `${state.provider}|${state.voice}|${current.input}`;
      chunks.push(current);
    }

    return chunks;
  }

  function makeChunks(words) {
    return state.provider === PROVIDERS.OPENAI ? makeOpenAIChunks(words) : makeGoogleChunks(words);
  }

  // ═══════════════════ Timing estimation ═══════════════════

  function applyTimepoints(chunk, duration) {
    const marks = chunk.words.filter(w => w.markName);
    const starts = new Map((chunk.timepoints || []).map(tp => [tp.markName, tp.timeSeconds]));

    for (let i = 0; i < marks.length; i++) {
      const word = marks[i];
      const startTime = starts.get(word.markName);
      const nextStart = i + 1 < marks.length ? starts.get(marks[i + 1].markName) : duration;

      if (typeof startTime !== 'number') continue;

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
      const startTime = elapsed;
      elapsed += duration * (weights[index] / totalWeight);
      word.startTime = startTime;
      word.endTime = index === words.length - 1 ? duration : elapsed;
    }
  }

  function hasWordTimings(chunk) {
    return chunk.words?.some(word => typeof word.startTime === 'number' && typeof word.endTime === 'number');
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
    return startWord ? startWord.startTime : 0;
  }

  // ═══════════════════ Audio playback ═══════════════════

  function b64ToBlob(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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

    const resp = await chrome.runtime.sendMessage({
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

    if (resp?.error) {
      throw new Error(resp.error);
    }

    if (!state.playing || state.readSessionId !== sessionId) {
      return;
    }

    const result = resp.results?.[0];
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

  async function startReading() {
    stopReading();
    const sessionId = state.readSessionId;

    // Reload preferences
    const prefs = await getSettings();
    state.provider = prefs.provider === PROVIDERS.OPENAI ? PROVIDERS.OPENAI : PROVIDERS.GOOGLE;
    state.voice = getSelectedVoice(prefs, state.provider);
    if (prefs.speed) state.speed = prefs.speed;
    state.segmentLanguage = resolveSegmentLanguage(state.provider, state.voice);

    const extracted = extractWords();
    const words = extracted.words;
    if (words.length === 0) {
      notify('error', 'No readable text found on this page.');
      return;
    }

    const chunks = makeChunks(words);
    const preparedKey = chunks.map(chunk => chunk.memoryKey).join('|');
    const playbackStart = findPlaybackStart(chunks, extracted.startWordIndex);

    for (const chunk of chunks) {
      const cached = state.preparedAssets.get(chunk.memoryKey);
      if (cached) {
        chunk.audioContent = cached.audioContent;
        chunk.timepoints = cached.timepoints || [];
      }
    }

    state.chunks = chunks;
    state.preparedKey = preparedKey;
    state.chunkIndex = playbackStart.chunkIndex;
    state.startChunkIndex = playbackStart.chunkIndex;
    state.startWordIndex = extracted.startWordIndex;
    state.playing = true;
    state.paused = false;
    state.synthesisError = null;

    const currentChunk = chunks[playbackStart.chunkIndex];
    if (!currentChunk?.audioContent) {
      notify('loading', 'Synthesizing audio…');
      try {
        await synthesizeChunk(currentChunk, playbackStart.chunkIndex, location.href, sessionId);
      } catch (e) {
        state.playing = false;
        notify('error', e.message);
        return;
      }
    }

    if (!state.playing || state.readSessionId !== sessionId) {
      return;
    }

    notify('playing', currentChunk?.audioContent ? 'Reading…' : 'Reading from cache…');
    playNextChunk();
    void prefetchChunks(chunks, location.href, sessionId, playbackStart.chunkIndex + 1);
  }

  function playNextChunk() {
    if (!state.playing || state.chunkIndex >= state.chunks.length) {
      stopReading();
      return;
    }

    const chunk = state.chunks[state.chunkIndex];
    if (!chunk.audioContent) {
      waitForChunk(state.chunkIndex, state.readSessionId);
      return;
    }

    const url = URL.createObjectURL(b64ToBlob(chunk.audioContent));
    const audio = new Audio(url);
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
      audio.play();
      if (hasWordTimings(chunk)) {
        runHighlightLoop(chunk);
      } else if (wordHL) {
        wordHL.clear();
      }
    });

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      cancelAnimationFrame(state.rafId);
      state.activeWordKey = null;
      state.chunkIndex++;
      playNextChunk();
    });

    audio.addEventListener('error', (e) => {
      console.error('[TTS Reader] Audio error', e);
      URL.revokeObjectURL(url);
      cancelAnimationFrame(state.rafId);
      state.activeWordKey = null;
      state.chunkIndex++;
      playNextChunk();
    });
  }

  // ═══════════════════ Highlight sync ═══════════════════

  function runHighlightLoop(chunk) {
    const markedWords = chunk.words.filter(w => typeof w.startTime === 'number');

    const step = () => {
      if (!state.playing || state.paused || !state.audio) return;
      const t = state.audio.currentTime;

      for (const w of markedWords) {
        if (t >= w.startTime && t < w.endTime) {
          applyHighlight(w);
          break;
        }
      }
      state.rafId = requestAnimationFrame(step);
    };
    state.rafId = requestAnimationFrame(step);
  }

  function applyHighlight(word) {
    if (!wordHL) return;
    const wordKey = `${state.chunkIndex}:${word.markName}:${word.startTime}`;
    if (state.activeWordKey === wordKey) return;

    state.activeWordKey = wordKey;
    wordHL.clear();
    try {
      wordHL.add(word.range);
      // Auto-scroll if the word is out of viewport
      const rect = word.range.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        const el = word.range.startContainer.parentElement;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch { /* DOM may have changed */ }
  }

  // ═══════════════════ Controls ═══════════════════

  function pauseReading() {
    if (!state.audio || !state.playing) return;
    if (state.paused) {
      state.paused = false;
      state.audio.play();
      if (hasWordTimings(state.chunks[state.chunkIndex])) {
        runHighlightLoop(state.chunks[state.chunkIndex]);
      }
      notify('playing', 'Reading…');
    } else {
      state.paused = true;
      state.audio.pause();
      cancelAnimationFrame(state.rafId);
      notify('paused', 'Paused');
    }
  }

  function stopReading() {
    const wasPlaying = state.playing;
    state.readSessionId += 1;
    state.playing = false;
    state.paused = false;
    if (state.audio) {
      state.audio.pause();
      state.audio = null;
    }
    cancelAnimationFrame(state.rafId);
    state.activeWordKey = null;
    state.synthesisError = null;
    state.startChunkIndex = 0;
    state.startWordIndex = 0;
    if (wordHL) wordHL.clear();
    if (wasPlaying) notify('ready', 'Ready');
  }

  function setSpeed(s) {
    state.speed = s;
    if (state.audio) state.audio.playbackRate = s;
  }

  function notify(status, message) {
    chrome.runtime.sendMessage({ action: 'statusUpdate', status, message }).catch(() => {});
  }

  // ═══════════════════ Message listener ═══════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.action) {
      case 'read':
        startReading().catch(error => notify('error', error.message));
        reply({ ok: true });
        break;
      case 'pause':
        pauseReading();
        reply({ ok: true });
        break;
      case 'stop':
        stopReading();
        reply({ ok: true });
        break;
      case 'setSpeed':
        setSpeed(msg.speed);
        reply({ ok: true });
        break;
      case 'toggleRead':
        if (state.playing) {
          pauseReading();
        } else {
          startReading().catch(error => notify('error', error.message));
        }
        reply({ ok: true });
        break;
      case 'getState':
        reply({
          playing: state.playing,
          paused: state.paused,
          speed: state.speed
        });
        break;
      default:
        reply({ ok: true });
    }
  });
})();
