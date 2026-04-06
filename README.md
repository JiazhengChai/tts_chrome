# Japanese TTS Reader — Chrome Extension

Read Japanese webpages, text documents, and PDFs aloud with Google Cloud Text-to-Speech or OpenAI TTS-1.

## Features

- **Multiple TTS backends** using GCP Neural2 / WaveNet voices or OpenAI TTS-1
- **Word-level highlighting** on normal webpages via the CSS Custom Highlight API (Chrome 105+)
- **Read from selection** — select text and click Read to start from that point and continue to the end of the article
- **Audio caching** — revisiting the same content skips the API call (stored in IndexedDB)
- **Speed control** — 0.5× to 2.0×
- **Keyboard shortcut** — `Alt+R` to toggle reading
- **PDF support** — extracts text from browser-opened PDFs, even when Chrome uses its built-in PDF viewer
- **Text document support** — works with browser-opened `.txt`, `.md`, `.json`, `.xml`, `.csv`, and similar text files

## Setup

### 1. Create an API key

You can use either provider:

#### Google Cloud Text-to-Speech

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Select or create a project
3. Make sure **Cloud Text-to-Speech API** is enabled:
   [Enable it here](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com)
4. Click **+ CREATE CREDENTIALS → API key**
5. *(Recommended)* Restrict the key:
   - Click **Edit API key**
   - Under **API restrictions**, choose **Restrict key** and select **Cloud Text-to-Speech API**
6. Copy the key

#### OpenAI

1. Open [OpenAI API keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Copy the key

### 2. Install the extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder (`tts_chrome/`)
4. Click the extension icon, open **⚙ Settings**, choose a provider, and paste that provider's API key

### 3. Use it

- Navigate to any webpage, text document, or PDF
- Click the extension icon → **▶ Read**
- Or select some text first, then click **▶ Read** to start from that point
- Use `Alt+R` to quickly toggle play/pause

### Notes

- PDF and text-document reading now exposes a text preview inside the popup or detached controller. Select text there to start from that point, and the active word highlights in the preview while audio plays. Chrome's built-in PDF viewer itself still does not expose a scriptable DOM text layer for true in-page highlighting.
- OpenAI TTS-1 does not expose provider word timing marks. On webpages, the extension estimates timing locally so selection starts and word highlighting are approximate rather than exact.
- Local `file://` PDFs or text files may require enabling **Allow access to file URLs** for the unpacked extension on `chrome://extensions/`.

## Cost

GCP TTS Neural2 voices: **free for the first 1 million characters/month**, then $0.016 per 1,000 characters.
Audio caching ensures you never pay twice for the same content.

OpenAI TTS-1 pricing varies by token usage; see the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing).

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker — API calls + IndexedDB cache |
| `content.js` | Content script — text extraction, playback, highlighting |
| `popup.html/css/js` | Extension popup UI |
| `styles.css` | Injected page CSS for `::highlight(tts-word)` |

## Requirements

- Chrome 105+ (for CSS Custom Highlight API)
- Either a Google Cloud project with Text-to-Speech API enabled or an OpenAI API key with access to TTS-1
