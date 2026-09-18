# AI Post Detector

Browser extension detecting AI-generated LinkedIn posts. Jev (a cheap decision
model on OpenRouter) scores every post; only posts it is unsure about go to an
Ollama LLM.

## Structure

```
├── src/
│   ├── background.js   # Service worker/script: API proxy, CORS bypass
│   ├── content.js      # LinkedIn: DOM observation, UI badges
│   ├── detector.js     # Detection: Jev → Ollama routing, score log
│   ├── prompt.js       # AI-detection system prompt (Ollama)
│   ├── jev-prompt.js   # Jev questions + routing cut-offs
│   ├── factcheck-prompt.js # Claim-extraction SOP (fact-check stage 0)
│   ├── popup.html      # Settings UI markup
│   ├── popup.js        # Settings UI logic
│   └── styles.css      # Verdict colors
├── eval/
│   ├── fetch-data.js   # Download labeled datasets (HuggingFace, no deps)
│   ├── gen-ai-posts.js # Generate AI half of eval set via Ollama
│   ├── run.js          # Run prompt against dataset, report accuracy
│   ├── run-jev.js      # Jev questions + routing against the dataset
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
OPENROUTER_API_KEY=... node eval/run-jev.js --limit 240 --pollute   # Jev routing vs gemma, same posts
```

Jev (`typesafe/jev-1.13`) is not a chat model: `POST openrouter.ai/api/alpha/decisions`
with `{model, state, questions}` returns a probability per question, no text, and
there is no system prompt. ~950 tokens, ~340ms and ~$0.00004 per post. Its scores
jitter slightly between calls (±0.04 on the same text) and move with the chrome
around a post, so treat cut-offs as ranges. Rules learned the hard way:
- The `criteria` (what yes/no mean) carry v4.3's false-positive traps; without
  them false alarms at 90% recall triple.
- One post per request. Batching posts into one `state` cuts tokens ~30% but
  drops separation from 0.98 to 0.84.
- It rejects lone UTF-16 surrogates, so never cut post text mid-pair (LinkedIn's
  𝗯𝗼𝗹𝗱 letters are astral).
- Re-check the cut-offs against the popup's logged scores ("Copy log"): the
  target is ~10% of the feed reaching Ollama.

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
LinkedIn DOM → content.js → detector.js → background.js → Jev (OpenRouter)
  slop < JEV_LOW   → LIKELY_HUMAN  (Jev decides)
  slop ≥ JEV_HIGH  → LIKELY_AI     (Jev decides)
  in between       → Ollama + v4.3 prompt → verdict
  no key / Jev error → Ollama for every post, as before
→ verdict + slop meter on the badge → CSS class; scores (no text) → storage jevLog

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
