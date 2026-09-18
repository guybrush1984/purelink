# AI Post Detector

Browser extension that flags AI-generated posts on LinkedIn. **Jev**, a fast
decision model, scores every post: the slop meter on each badge. Only the posts
Jev is unsure about go on to an LLM via Ollama.

![Demo](demo.gif)

## How it works

Jev (TypeSafe's `jev-1.13`, via OpenRouter) doesn't write text. It reads a post and
answers one question with a probability: *was this written by an AI model?* Below
0.51 the post is marked human, from 0.65 AI, with no LLM call. The ~9% in between
go to the LLM with the full detection prompt.

| On 240 LinkedIn posts, page clutter left in | AI caught | Humans wrongly flagged | Cost / 1,000 posts | Time / post |
|---|---|---|---|---|
| Gemma 4 31B alone | 105/120 | 12/120 | $1.20 | 3.89 s |
| Jev alone (AI from 0.58) | 100/120 | 6/120 | $0.04 | 0.36 s |
| **Jev, then Gemma 4 31B** | **106/120** | **5/120** | **$0.15** | **0.71 s** |

Jev's cost and speed are measured. Gemma's are computed from exact token counts at
$0.75 / $1.00 per million tokens. The cut-offs were fitted on this test set, so the
popup shows what share of *your* feed reaches the LLM; aim for about 10%.

## Setup

**1. Jev (recommended).** Paste an [OpenRouter](https://openrouter.ai) API key in
the popup. Post text goes to OpenRouter and TypeSafe (their listed policy: no
training, no prompt retention). Leave it empty and every post goes to the LLM.

**2. An LLM via Ollama**, for the posts Jev is unsure about. Pick one:

- **No install, straight to ollama.com.** Create an API key at
  [ollama.com](https://ollama.com), then in the popup set the server to
  `https://ollama.com` and paste the key. Nothing runs on your machine. Post
  text leaves your machine, and the free tier has usage caps.
- **Local daemon.** Install [Ollama](https://ollama.com), then either:
  - **Cloud models** (no GPU needed): `ollama signin`, `ollama pull gemma4:31b-cloud`.
    The daemon proxies to ollama.com, so post text still leaves your machine.
  - **Local models** (private, ~8GB+ VRAM): `ollama pull ministral-3:14b` or
    `qwen3.5:9b`, then pick it in the popup. Nothing leaves your machine.

The **fact-checker needs an ollama.com API key either way**: web search and web
fetch live only on ollama.com, and the local daemon does not serve them. It is a
separate credential from `ollama signin`.

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

With Jev, badges read like `Likely AI · 78%`: Jev's probability that the post is
AI-written, with a meter bar. Posts Jev decides alone get **Likely Human** or
**Likely AI**; the LLM gives its full verdict on the rest. Hover a badge to see
which one decided. The popup shows the share of your feed that reached the LLM,
the two cut-offs to widen or narrow that band, and **Copy log** (scores only,
never post text) for re-fitting them.

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
