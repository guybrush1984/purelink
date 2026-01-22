# AI Post Detector

Chrome extension detecting AI-generated LinkedIn posts via local Ollama LLM.

## Structure

```
├── src/
│   ├── background.js   # Service worker: API proxy, CORS bypass
│   ├── content.js      # LinkedIn: DOM observation, UI badges
│   ├── detector.js     # Detection: request building, response parsing
│   ├── prompt.js       # System prompt constant
│   ├── popup.html      # Settings UI markup
│   ├── popup.js        # Settings UI logic
│   └── styles.css      # Verdict colors
├── icons/
├── manifest.json
├── README.md
└── CLAUDE.md
```

## Data Flow

```
LinkedIn DOM → content.js → detector.js → background.js → Ollama → verdict → CSS class
```

## Coding Rules

### Keep It Minimal
- No abstractions until needed 3+ times
- No comments explaining obvious code
- Delete dead code, don't comment it out

### JavaScript
- `const` by default, `let` only when reassigning
- Arrow functions for callbacks
- Early returns over nested conditionals

### Naming
- Files: lowercase with dashes
- Functions: camelCase, verb-first
- Constants: UPPER_SNAKE_CASE
- CSS classes: kebab-case with `ai-` prefix

### Chrome Extension
- Content scripts can't cross-origin fetch → use background
- Message passing: `{type: "ACTION_NAME", ...payload}`
- Body as object in sendMessage, stringify in background

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
