# Japanese TTS Reader — Chrome Extension

Read Japanese web articles aloud with **word-level highlighting**, powered by Google Cloud Text-to-Speech.

## Features

- **Natural Japanese speech** using GCP Neural2 / WaveNet voices
- **Word-level highlighting** via the CSS Custom Highlight API (Chrome 105+)
- **Read from selection** — select text and click Read to start from that point and continue to the end of the article
- **Audio caching** — revisiting the same content skips the API call (stored in IndexedDB)
- **Speed control** — 0.5× to 2.0×
- **Keyboard shortcut** — `Alt+R` to toggle reading

## Setup

### 1. Create a GCP API key

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Select or create a project
3. Make sure **Cloud Text-to-Speech API** is enabled:
   [Enable it here](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com)
4. Click **+ CREATE CREDENTIALS → API key**
5. *(Recommended)* Restrict the key:
   - Click **Edit API key**
   - Under **API restrictions**, choose **Restrict key** and select **Cloud Text-to-Speech API**
6. Copy the key

### 2. Install the extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder (`tts_chrome/`)
4. Click the extension icon, open **⚙ Settings**, and paste your API key

### 3. Use it

- Navigate to any Japanese article
- Click the extension icon → **▶ Read**
- Or select some text first, then click **▶ Read** to start from that point
- Use `Alt+R` to quickly toggle play/pause

## Cost

GCP TTS Neural2 voices: **free for the first 1 million characters/month**, then $0.016 per 1,000 characters.
Audio caching ensures you never pay twice for the same content.

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
- A Google Cloud project with Text-to-Speech API enabled
