# AI Post Detector

Chrome extension detecting AI-generated LinkedIn posts via local Ollama LLM.

## Structure

```
manifest.json      # Extension config
background.js      # Service worker: API proxy, CORS bypass
content.js         # LinkedIn injection: DOM observation, UI
detector.js        # Detection: request building, response parsing
prompt.js          # System prompt constant
popup.html/js      # Settings UI
styles.css         # Verdict colors
```

## Data Flow

```
LinkedIn DOM → content.js → detector.js → background.js → Ollama → verdict → CSS class
```

## Coding Rules

### Keep It Minimal
- No abstractions until needed 3+ times
- No utility functions for one-off operations
- No comments explaining obvious code
- Delete dead code, don't comment it out

### JavaScript
- Use `const` by default, `let` only when reassigning
- Arrow functions for callbacks
- Template literals over concatenation
- Early returns over nested conditionals
- Destructure when cleaner

### Naming
- Files: lowercase with dashes
- Functions: camelCase, verb-first (detectContent, parseVerdict)
- Constants: UPPER_SNAKE_CASE
- CSS classes: kebab-case with `ai-` prefix

### Chrome Extension Specifics
- Content scripts can't make cross-origin requests → use background
- Message passing: `{type: "ACTION_NAME", ...payload}`
- Storage: chrome.storage.local for persistence
- Body must be object in sendMessage, stringify in background

### Error Handling
- Return objects with error state, don't throw
- `{error: "message"}` or `{data: result}`
- Log errors with `[AI Detector]` prefix

## Key Constants

```javascript
DEFAULT_MODEL = "ministral-3:14b-cloud"
DEFAULT_URL = "http://localhost:11434"
MAX_TEXT_LENGTH = 2000
VISIBILITY_THRESHOLD = 0.3
DEBOUNCE_MS = 500
```

## Verdicts

```
DEFINITELY_HUMAN → green   #22c55e
LIKELY_HUMAN     → ltgreen #86efac
UNCERTAIN        → yellow  #f59e0b
LIKELY_AI        → ltred   #f87171
DEFINITELY_AI    → red     #dc2626
```

## Don't

- Don't add TypeScript, build tools, or bundlers
- Don't add libraries or dependencies
- Don't over-engineer for hypothetical features
- Don't add loading states or animations
- Don't add analytics or telemetry
