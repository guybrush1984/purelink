# AI Post Detector

Browser extension that detects AI-generated posts on LinkedIn using an LLM via Ollama.

![Demo](demo.gif)

## Setup

1. Install [Ollama](https://ollama.com) — required either way: it serves the API the extension talks to
2. Pick a model:
   - **Cloud** (default, no GPU needed): `ollama signin`, then `ollama pull gemma4:31b-cloud`. Runs on ollama.com's servers — post text leaves your machine; free tier has usage caps
   - **Local** (private, needs ~8GB+ VRAM): `ollama pull ministral-3:14b` or `qwen3.5:9b`, then set the model in the extension popup
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
