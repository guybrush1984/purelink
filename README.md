# AI Post Detector

Browser extension that flags AI-generated posts on LinkedIn. **Jev**, a fast
decision model, answers 13 quick questions about every post; the answers,
weighted, give each post an AI score and a verdict. No LLM runs to detect AI.

![Demo](demo.gif)

## How it works

Jev (TypeSafe's `jev-1.13`) doesn't write text. It reads a post and answers typed
questions with probabilities: *was this written by an AI model?*, *does it use em
dashes to punch up clauses?*, *does it end on a lesson for everyone?*, *does it show
typing residue like double spaces?* and nine more. Fixed weights, learned from
~4,900 labeled posts, combine the 13 answers into one score. Click a badge to see
every answer and which ones pushed the post towards AI or human.

Tested once on posts kept out of all the tuning: 630 posts by LinkedIn authors
from 2021 (before ChatGPT), 300 human answers from HC3, and 415 AI posts from 7
AI vendors whose models were never used for training, plus AI rewrites of the
held-out authors' real posts. With LinkedIn's page clutter around each post:

| Verdict | Real authors flagged | AI posts caught |
|---|---|---|
| **Likely AI** or **AI** | 0.2% (HC3: 0.3%) | 68%: 98% of plain AI posts, 65% "write like a human", 53% polished rewrites |
| **Uncertain** or above | 4.1% (HC3: 1.3%) | 78% |

Lightly AI-edited human posts mostly pass as human (14% caught). Very formulaic
human writers get **Uncertain** more often than the average author. About
$0.04 per 1,000 posts on OpenRouter, ~0.6 s per post.

## Clickbait

The same request also asks four questions about bait, so it costs no extra call.
A post gets a **Bait** chip when one of them is confident:

- **engagement bait** — "Comment GUIDE and I'll send it", "Repost ♻️", "Agree?", "What would you add? 👇"
- **curiosity hook** — an opening that holds back the point so you click "see more"
- **rage bait** — "Unpopular opinion:", "X is dead", provocation as the device

Measured against 360 posts labeled by hand (`eval/bait-rubric.md` has the rules),
on the 120 kept aside: **76% of flagged posts really are bait, and 89% of bait is
caught**; 8 of 92 clean posts get flagged, several of them borderline. Rage bait is
too rare in real feeds to measure that way — 5 of the 360 posts — so it was checked separately:
perfectly on 40 hand-written posts (`eval/bait-rage-fixtures.jsonl`), and on 36 real posts picked
for sounding provocative it caught 4 of the 5 genuine ones and flagged 4 of 31 look-alikes. Bait is common in AI-written posts
(56% of them, against 18% of human posts).

## Setup

**1. A Jev key.** Paste either key in the popup:
- an [OpenRouter](https://openrouter.ai) API key (`sk-or-…`), billed per post, or
- a [TypeSafe](https://typesafe.ai) API key, sent straight to `api.typesafe.ai`.

Post text goes to OpenRouter and/or TypeSafe (their listed policy: no training,
no prompt retention). Without a key, posts get an **Add a Jev key** badge.

**2. Ollama, only for the fact-checker.** Pick one:

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

- 🟢 **Human** / **Likely Human**: reads like a real author's post
- 🟡 **Uncertain**: more AI-like than 95% of real authors' posts
- 🔴 **Likely AI** / **AI**: more AI-like than 98% / 99.5% of them

The bar under each badge is the AI score. Click the badge for the score, how it
compares to real authors' posts, and all 13 answers, sorted by how far each moved
the post from a typical human post (▲ AI, ▼ human). The popup shows how much of
*your* feed is flagged, and **Copy log** (answers and scores only, never post
text) for re-checking the cuts.

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
