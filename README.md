# AI Post Detector

Browser extension that detects AI-generated posts on LinkedIn using local LLM via Ollama.

![Demo](demo.gif)

## Setup

1. Install [Ollama](https://ollama.com)
2. Pull a model: `ollama pull ministral-3:14b-cloud`
3. Build for your browser:
   ```bash
   make chrome   # or: make firefox
   ```
4. Load extension:
   - **Chrome**: `chrome://extensions` → Developer mode → Load unpacked
   - **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on
5. Open LinkedIn and scroll

## Verdicts

- 🟢 **Human** / **Likely Human** - Authentic content
- 🟡 **Uncertain** - Mixed signals
- 🔴 **Likely AI** / **AI** - Synthetic patterns detected

## Structure

```
├── src/                   # Shared source code
├── icons/                 # Extension icons
├── manifest.chrome.json   # Chrome manifest
├── manifest.firefox.json  # Firefox manifest
├── Makefile               # Build script
└── CLAUDE.md              # Dev guide
```

## License

MIT
