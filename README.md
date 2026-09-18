# AI Post Detector

Browser extension that detects AI-generated posts on LinkedIn using an LLM via Ollama.

![Demo](demo.gif)

## Setup

Pick one of two ways to reach a model.

**A. No install — straight to ollama.com.** Create an API key at
[ollama.com](https://ollama.com), then in the extension popup set the server to
`https://ollama.com` and paste the key. Nothing runs on your machine. Post text
leaves your machine, and the free tier has usage caps.

**B. Local daemon.** Install [Ollama](https://ollama.com), then either:
- **Cloud models** (no GPU needed): `ollama signin`, `ollama pull gemma4:31b-cloud`.
  The daemon proxies to ollama.com — post text still leaves your machine.
- **Local models** (private, ~8GB+ VRAM): `ollama pull ministral-3:14b` or
  `qwen3.5:9b`, then pick it in the popup. Nothing leaves your machine.

The **fact-checker needs an API key either way** — web search and web fetch live
only on ollama.com and the local daemon does not serve them. It is a separate
credential from `ollama signin`.

Then build for your browser:

```bash
make chrome   # or: make firefox
```

Load the extension:
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked
- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on

Open LinkedIn and scroll.

## Verdicts

- 🟢 **Human** / **Likely Human** - Authentic content
- 🟡 **Uncertain** - Mixed signals
- 🔴 **Likely AI** / **AI** - Synthetic patterns detected

## Fact-check

Every post gets a **Fact-check** button. It is on demand only — a check costs
several searches and model calls, so nothing runs until you click.

It extracts the post's checkable factual claims, searches for each one, reads
the sources (including any the author linked), then **annotates the post in
place** — each claim highlighted where it sits, with the source next to it:

- 🟩 **SUPPORTED** — a source states it
- 🟥 **CONTRADICTED** — a source states something incompatible
- 🟧 **UNVERIFIABLE** — nothing found, sources disagree, or the page could not be read

Click the tag next to a claim for the verdict, the verbatim quote, and a link
to the source.

Most posts contain no checkable claims and exit after one call, which is what
makes this affordable. A compact bar reports progress; its **trace** toggle
shows every step — claims found and rejected with reason codes, each search
query, every URL tried and whether it could be read.

A source that fails to load is never treated as disagreement.

## Structure

```
├── src/                   # Shared source code
├── eval/                  # Prompt evaluation harness + fixtures
├── icons/                 # Extension icons
├── manifest.chrome.json   # Chrome manifest
├── manifest.firefox.json  # Firefox manifest
├── Makefile               # Build script
├── DOM-NOTES.md           # Measured LinkedIn DOM facts
├── RETRIEVAL-NOTES.md     # web_search / web_fetch behaviour
└── CLAUDE.md              # Dev guide
```

## License

MIT
