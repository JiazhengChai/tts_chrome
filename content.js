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
    speed: 1.0,
    voice: 'ja-JP-Neural2-B'
  };

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
    const hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;

    // Determine reading root
    let root = findArticle();
    if (hasSelection) {
      // Make sure we use a container that includes the selection
      const selNode = sel.getRangeAt(0).startContainer;
      if (!root.contains(selNode)) {
        let container = selNode.nodeType === Node.TEXT_NODE ? selNode.parentElement : selNode;
        while (container && container !== document.body && !BLOCK_TAGS.has(container.tagName)) {
          container = container.parentElement;
        }
        root = container || document.body;
      }
    }

    const nodes = textNodesUnder(root);
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const words = [];

    const selRange = hasSelection ? sel.getRangeAt(0) : null;
    const selPoint = hasSelection ? document.createRange() : null;
    let startWordIndex = 0;
    let foundStart = !hasSelection;

    if (selPoint) {
      selPoint.setStart(selRange.startContainer, selRange.startOffset);
      selPoint.collapse(true);
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
  function makeChunks(words, limitBytes = 4800) {
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

  async function startReading() {
    stopReading();

    // Reload preferences
    const prefs = await chrome.storage.sync.get(['voice', 'speed']);
    if (prefs.voice) state.voice = prefs.voice;
    if (prefs.speed) state.speed = prefs.speed;

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

    const missingChunks = chunks.filter(chunk => !chunk.audioContent);

    if (missingChunks.length === 0) {
      notify('playing', 'Reading from cache…');
      playNextChunk();
      return;
    }

    notify('loading', `Synthesizing ${missingChunks.length} chunk(s)…`);

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'synthesize',
        chunks: missingChunks.map(chunk => ({
          text: chunk.text,
          ssml: chunk.ssml,
          index: chunks.indexOf(chunk)
        })),
        voice: state.voice,
        url: location.href
      });

      if (resp?.error) { notify('error', resp.error); state.playing = false; return; }
      if (!state.playing) return; // stopped while waiting

      // Attach audio data
      for (const r of resp.results) {
        chunks[r.chunkIndex].audioContent = r.audioContent;
        chunks[r.chunkIndex].timepoints = r.timepoints || [];
        state.preparedAssets.set(chunks[r.chunkIndex].memoryKey, {
          audioContent: r.audioContent,
          timepoints: r.timepoints || []
        });
      }

      notify('playing', 'Reading…');
      playNextChunk();
    } catch (e) {
      notify('error', e.message);
      state.playing = false;
    }
  }

  function playNextChunk() {
    if (!state.playing || state.chunkIndex >= state.chunks.length) {
      stopReading();
      return;
    }

    const chunk = state.chunks[state.chunkIndex];
    if (!chunk.audioContent) { state.chunkIndex++; playNextChunk(); return; }

    const url = URL.createObjectURL(b64ToBlob(chunk.audioContent));
    const audio = new Audio(url);
    audio.playbackRate = state.speed;
    state.audio = audio;

    audio.addEventListener('loadedmetadata', () => {
      applyTimepoints(chunk, audio.duration);
      if (state.chunkIndex === state.startChunkIndex) {
        audio.currentTime = findSeekTime(chunk, state.startWordIndex);
      }
      audio.play();
      runHighlightLoop(chunk);
    });

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      cancelAnimationFrame(state.rafId);
      state.chunkIndex++;
      playNextChunk();
    });

    audio.addEventListener('error', (e) => {
      console.error('[TTS Reader] Audio error', e);
      URL.revokeObjectURL(url);
      cancelAnimationFrame(state.rafId);
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
      runHighlightLoop(state.chunks[state.chunkIndex]);
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
    state.playing = false;
    state.paused = false;
    if (state.audio) {
      state.audio.pause();
      state.audio = null;
    }
    cancelAnimationFrame(state.rafId);
    state.activeWordKey = null;
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
        startReading();
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
        if (state.playing) pauseReading(); else startReading();
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
