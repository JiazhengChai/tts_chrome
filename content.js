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
    chunkIndex: 0,
    rafId: null,
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

    let started = !hasSelection;
    const selRange = hasSelection ? sel.getRangeAt(0) : null;

    for (const node of nodes) {
      // Skip nodes before the selection start
      if (!started) {
        if (node === selRange.startContainer) {
          started = true;
          // For this node, skip segments entirely before selection offset
          const startOff = selRange.startOffset;
          for (const seg of segmenter.segment(node.textContent)) {
            if (seg.index + seg.segment.length <= startOff) continue;
            pushWord(words, node, seg);
          }
          continue;
        }
        // Check if this node is a descendant of the selection start container
        if (selRange.startContainer.contains?.(node)) {
          started = true;
        } else {
          continue;
        }
      }

      for (const seg of segmenter.segment(node.textContent)) {
        pushWord(words, node, seg);
      }
    }

    return words;
  }

  function pushWord(words, node, seg) {
    try {
      const r = document.createRange();
      r.setStart(node, seg.index);
      r.setEnd(node, seg.index + seg.segment.length);
      words.push({
        text: seg.segment,
        isWordLike: seg.isWordLike,
        range: r
      });
    } catch { /* invalid offset — skip */ }
  }

  // ═══════════════════ Chunking ═══════════════════

  /** UTF-8 byte length of a string. */
  function byteLen(s) {
    return new TextEncoder().encode(s).byteLength;
  }

  /** Split words into chunks whose text stays under `limit` UTF-8 bytes.
   *  GCP TTS hard-limits input to 5000 bytes; we use 4800 for safety. */
  function makeChunks(words, limitBytes = 4800) {
    const chunks = [];
    let buf = { text: '', words: [], bytes: 0 };

    for (const w of words) {
      const wb = byteLen(w.text);
      if (buf.bytes + wb > limitBytes && buf.text.length > 0) {
        chunks.push(buf);
        buf = { text: '', words: [], bytes: 0 };
      }
      buf.text += w.text;
      buf.words.push(w);
      buf.bytes += wb;
    }
    if (buf.text.length > 0) chunks.push(buf);
    return chunks;
  }

  // ═══════════════════ Timing estimation ═══════════════════

  function assignTimings(words, duration) {
    let totalWeight = 0;
    for (const w of words) {
      // Word-like segments get full weight; punctuation/whitespace get a fraction
      w.weight = w.isWordLike ? Math.max(w.text.length, 1) : w.text.length * 0.15;
      totalWeight += w.weight;
    }
    if (totalWeight === 0) return;

    let t = 0;
    for (const w of words) {
      w.startTime = t;
      w.dur = duration * (w.weight / totalWeight);
      w.endTime = t + w.dur;
      t = w.endTime;
    }
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

    const words = extractWords();
    if (words.length === 0) {
      notify('error', 'No readable text found on this page.');
      return;
    }

    const chunks = makeChunks(words);
    state.chunks = chunks;
    state.chunkIndex = 0;
    state.playing = true;
    state.paused = false;

    notify('loading', `Synthesizing ${chunks.length} chunk(s)…`);

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'synthesize',
        chunks: chunks.map((c, i) => ({ text: c.text, index: i })),
        voice: state.voice,
        url: location.href
      });

      if (resp?.error) { notify('error', resp.error); state.playing = false; return; }
      if (!state.playing) return; // stopped while waiting

      // Attach audio data
      for (const r of resp.results) {
        chunks[r.chunkIndex].audioContent = r.audioContent;
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
      assignTimings(chunk.words, audio.duration);
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
    const step = () => {
      if (!state.playing || state.paused || !state.audio) return;
      const t = state.audio.currentTime;

      for (const w of chunk.words) {
        if (w.isWordLike && t >= w.startTime && t < w.endTime) {
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
