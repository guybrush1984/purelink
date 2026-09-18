# AI Post Detector

Browser extension detecting AI-generated LinkedIn posts via local Ollama LLM.

## Structure

```
├── src/
│   ├── background.js   # Service worker/script: API proxy, CORS bypass
│   ├── content.js      # LinkedIn: DOM observation, UI badges
│   ├── detector.js     # Detection: request building, response parsing
│   ├── prompt.js       # AI-detection system prompt
│   ├── factcheck-prompt.js # Claim-extraction SOP (fact-check stage 0)
│   ├── popup.html      # Settings UI markup
│   ├── popup.js        # Settings UI logic
│   └── styles.css      # Verdict colors
├── eval/
│   ├── fetch-data.js   # Download labeled datasets (HuggingFace, no deps)
│   ├── gen-ai-posts.js # Generate AI half of eval set via Ollama
│   ├── run.js          # Run prompt against dataset, report accuracy
│   ├── factcheck-samples/ # Claim-rich fixtures for the extraction gate
│   └── data/           # JSONL datasets (gitignored)
├── icons/
├── DOM-NOTES.md        # Measured LinkedIn DOM facts — re-verify, they rot
├── RETRIEVAL-NOTES.md  # Ollama web_search/web_fetch behaviour and failure modes
├── manifest.chrome.json
├── manifest.firefox.json
├── Makefile
└── CLAUDE.md
```

## Build

```bash
make chrome    # → manifest.json for Chrome
make firefox   # → manifest.json for Firefox
```

## Eval

```bash
node eval/fetch-data.js      # download human LinkedIn posts + AIGTBench proxy
node eval/gen-ai-posts.js    # generate AI posts (needs Ollama running)
node eval/run.js --model qwen3.5:9b --limit 100   # measure prompt accuracy
```

Datasets are `{"text", "label": "human"|"ai", "source"}` JSONL in `eval/data/`.
Caveats: no public labeled LinkedIn AI dataset exists; human posts are real
LinkedIn authors (recent ones could be AI-assisted), AI posts are self-generated.
Run the eval before and after any prompt change.

## LinkedIn DOM

See `DOM-NOTES.md` for measured facts about the feed DOM (post text is CSS-clamped
not truncated; comment nodes need dedup; author's own comments carry an "Author"
badge). Re-run its probes before relying on them — LinkedIn ships new feeds often.

## Data Flow

```
Detection (automatic, on scroll):
LinkedIn DOM → content.js → detector.js → background.js → Ollama → verdict → CSS class

Fact-check (on demand, per post):
click → content.js opens a port → background.js → factcheck.js
  stage 0  extract claims      → local Ollama       (most posts exit here)
  stage 1  search per claim    → ollama.com/api/web_search
  stage 2  fetch cited source  → ollama.com/api/web_fetch
  stage 3  verdict per claim   → local Ollama
  every step emits a trace event → live panel on the card
```

Stage 0 is a gate, not a formality: most posts yield zero checkable claims and
cost one call. Verdicts are SUPPORTED / CONTRADICTED / UNVERIFIABLE, and never
carry a verdict without a citation URL and a verbatim quote. Retrieval failure
is UNVERIFIABLE, never CONTRADICTED — `RETRIEVAL-NOTES.md` explains why that
needs defending in code (web_fetch fails with HTTP 200 and an empty body).

## Browser Compatibility

All JS files use `const api = typeof browser !== "undefined" ? browser : chrome;`

| Feature | Chrome | Firefox |
|---------|--------|---------|
| Manifest | v3 | v2 |
| Background | Service worker | Script |
| Header strip | declarativeNetRequest | webRequest |

## Coding Rules

### Keep It Minimal
- No abstractions until needed 3+ times
- No comments explaining obvious code
- Delete dead code, don't comment it out

### JavaScript
- `const` by default, `let` only when reassigning
- Arrow functions for callbacks
- Early returns over nested conditionals
- Use `api` variable for browser compatibility

### Naming
- Files: lowercase with dashes
- Functions: camelCase, verb-first
- Constants: UPPER_SNAKE_CASE
- CSS classes: kebab-case with `ai-` prefix

## Verdicts

```
DEFINITELY_HUMAN → green   #22c55e
LIKELY_HUMAN     → ltgreen #86efac
UNCERTAIN        → yellow  #f59e0b
LIKELY_AI        → ltred   #f87171
DEFINITELY_AI    → red     #dc2626
```

## Don't

- Add TypeScript, build tools, or bundlers
- Add libraries or dependencies
- Over-engineer for hypothetical features
