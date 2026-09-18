# LinkedIn DOM Notes

Measured 2026-09-08 against the live feed, new RSC UI ("flagship-web").
Classic selectors matched 0 posts; everything below is the hashed-class UI.

These facts rot when LinkedIn ships a new feed. Re-run the probes at the
bottom before trusting anything here.

## Post text is NOT truncated

The "… more" control is a **CSS clamp**, not DOM truncation. The text
container is `-webkit-line-clamp: 3` + `overflow: hidden`; the full body is
in the DOM at all times.

Verified by clicking "more" on 6 posts and diffing `innerText.length`:

| before | after | delta | scrollH before | clientH after |
|--------|-------|-------|----------------|---------------|
| 835 | 828 | -7 | 340 | 340 |
| 930 | 923 | -7 | 360 | 360 |
| 569 | 562 | -7 | 220 | 220 |
| 457 | 450 | -7 | 200 | 200 |
| 702 | 695 | -7 | 300 | 300 |
| 347 | 340 | -7 | 180 | 180 |

Delta is the `"… more"` label being removed, nothing else. `scrollHeight`
before always equals `clientHeight` after: fully laid out, merely clipped.

**Consequence:** `extractText` gets complete post bodies. No expansion click
is needed, and detection accuracy is not silently degraded by clamping.
`MAX_TEXT = 2000` in `detector.js` remains the only real cut.

## Comments

### Dedup is mandatory

`[componentkey^="replaceableComment"]` matches nested elements sharing the
prefix: **19 nodes for 7 actual comments** (~2.7x). Always dedup on the full
`componentkey` value.

`extractText`'s comment-stripping currently runs redundant `String.replace`
passes because of this. Harmless for stripping; not harmless for anything
that counts or collects.

### The componentkey carries the parent post URN

```
replaceableComment_urn:li:comment:(urn:li:activity:7502288029076676609,7502296092789825536)
                                   ^ parent post URN                    ^ comment id
```

So comment -> post association does not depend on DOM containment, and the
post permalink is derivable: `/feed/update/urn:li:activity:<id>/`.

### Post author's own comments carry an "Author" badge

A `<p>` whose only text node is `Author` (localized -- `Auteur` in FR) is
rendered inside comments written by the post's author. Verified: OP badged,
other commenters not, across two posts (8 of 19 nodes).

Class names are hashed, so **the localized string is the only hook**. Brittle
by construction; match `/^(Author|Auteur)$/i` on own text nodes, not innerText.

### Comments barely render in the feed

**7 unique comments across 30 loaded posts**; only 4 posts had any. No "load
more comments" control was present anywhere in the feed.

Anything that needs the author's comment (e.g. "link in comments") cannot be
served from the feed DOM. Fetch the permalink instead -- clicking the visible
"Comment" button opens a reply composer and risks a stray interaction.

## Outbound links

**Correction to an earlier reading of this feed.** A first pass reported "zero
`lnkd.in`" — that was a bad probe, not a fact. `a[href*="lnkd.in"]` misses
everything, because LinkedIn percent-encodes the target inside a wrapper.

Real shape:

```
href = https://www.linkedin.com/safety/go/?url=<percent-encoded target>
```

Decode it and you usually get the destination directly:

```js
decodeURIComponent(new URL(a.href).searchParams.get('url'))
```

Observed across 3 wrapped links in one feed load:

| anchor text | decoded `?url=` |
|---|---|
| `Visit my website` | `http://Starcloud.com` |
| `https://lnkd.in/g-jkGaC3` | `https://lnkd.in/g-jkGaC3` |
| article share card | full `reuters.com/business/media-telecom/...` URL |

So **no redirect-following is needed in the common case** — the wrapper hands
you the real URL. Only the bare-paste case leaves an `lnkd.in` shortener that
still needs resolving (one HEAD/GET, or Ollama `/api/web_fetch`).

Probe with `a[href*="/safety/go"]`, never `a[href*="lnkd.in"]`.

## Post identity: there is none without comments

**The permalink route is blocked for most posts.** Scanned every post card for
`urn:li:(activity|ugcPost|share):\d+` across attributes, `__reactProps`, and
hrefs — zero hits. On a feed load with no comments rendered, the URN appears
**nowhere in the page's raw HTML** (0 occurrences, 0 in `<script>` tags).

The URN only exists on comment nodes' `componentkey`. No comments -> no URN ->
no permalink to fetch. A post card's only handle is its `componentkey`, an
ephemeral client-side render UUID (e.g. `7875a567-3539-40da-b93f-1ad4433002d4`),
useless as a post id.

Post cards also carry no timestamp link and no overflow-menu button in the DOM
at scan time. React internals *are* present (`__reactFiber$`, `__reactProps$`),
so that probe was real, not vacuous.

## The extension polluted its own input (RSC path) — FIXED

`observe()` calls `markPending()`, which does `post.appendChild(badge)` with the
text `scanning…`. `processPost()` then calls `extractText(post)`, which on the
RSC path falls through to `post.innerText` — badge included.

Verified live: 5 of 5 pending posts had `innerText` ending in `scanning…`.

```
"...ttps://lnkd.in/g-jkGaC3 ⏎ … more ⏎ scanning…"
"...mit, sources say ⏎⏎ reuters.com ⏎⏎ scanning…"
```

The clamp control's `… more` label rides along too. So every RSC-path post is
sent to the model with `… more` and `scanning…` glued to the end.

Classic path is unaffected — `TEXT_SELECTORS` returns a sub-element. The eval
never sees this either, since `eval/run.js` reads clean JSONL. Prompt v4.3's
"What You Receive" guard covers LinkedIn's chrome, not the extension's own.

Fixed in `extractText` by hiding `.ai-detected-badge` (`display:none`) around
the `innerText` read, then restoring. `innerText` skips non-rendered nodes, so
this excludes the badge by element.

**Not** by string-stripping: verdict labels are `Human`, `AI`, `Uncertain` —
real words that occur in posts. Confirmed live, a post carrying a settled
verdict read `"...View all recommendations⏎Human"`; stripping that string would
have eaten the author's own words.

Verified on the live feed, 4 badged posts, 4/4 clean:

```
before  "he least.⏎… more⏎scanning…"   →  after  " I typed the least.⏎… more"
before  " all recommendations⏎Human"   →  after  "w⏎View all recommendations"
```

Badges restored correctly afterwards (no visual side effect).

LinkedIn's own `… more` clamp label is deliberately left in: it is LinkedIn
chrome, which prompt v4.3 is tuned to tolerate and `eval/run.js --pollute`
models. Removing it would change the input distribution the prompt was fitted
on, so it needs an eval, not a patch.

## Locating a claim in the post text

Highlighting a claim means finding the model's quote in the DOM. Two things
break naive matching, both measured on the live feed:

**Newlines.** The model quotes from `innerText`, which inserts newlines between
blocks that the DOM's text nodes do not contain. Flatten text nodes to
single-spaced text and keep an index back to `(node, offset)`.

**Typography.** LinkedIn posts carry curly apostrophes and quotes (U+2019,
U+201C/D) and en/em dashes; the model normalises them to ASCII when it quotes
back. Measured on 3 feed posts containing such characters:

| | matched |
|---|---|
| without folding | 0 / 3 |
| with folding | 3 / 3 |

So without folding, **every claim containing an apostrophe silently fails to
highlight** — and in French that is nearly every claim. Fold U+2018/U+2019/
U+02BC to `'`, U+201C/D to `"`, U+2013/U+2014 to `-`. All are 1:1, so the
index map stays aligned.

A claim usually spans several text nodes. Wrap each overlapping node
separately, walking from the highest node index down — wrapping splits nodes
and would invalidate offsets computed left to right.

## Re-verification probes

```js
// UI variant + post count
document.querySelectorAll('.feed-shared-update-v2').length            // classic
[...document.querySelectorAll('main [componentkey]')]
  .filter(e => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(e.getAttribute('componentkey'))
            && (e.innerText || '').length >= 150).length              // RSC

// clamp vs truncation: expect scrollH >> clientH, text unchanged after click
const s = document.querySelector('main span[tabindex="-1"]');
[getComputedStyle(s).webkitLineClamp, s.scrollHeight, s.clientHeight, s.innerText.length]

// outbound links: use the wrapper, not lnkd.in
[...document.querySelectorAll('main a[href*="/safety/go"]')]
  .map(a => decodeURIComponent(new URL(a.href).searchParams.get('url')))

// post URN: expect [] until a comment renders
(document.documentElement.innerHTML.match(/urn:li:(?:activity|ugcPost):\d+/g) || []).length

// self-pollution: expect false after the fix
[...document.querySelectorAll('main [componentkey]')]
  .some(p => (p.innerText || '').includes('scanning'))

// comment dedup ratio: expect > 1
document.querySelectorAll('[componentkey^="replaceableComment"]').length /
new Set([...document.querySelectorAll('[componentkey^="replaceableComment"]')]
  .map(c => c.getAttribute('componentkey'))).size
```

Note: Chrome's extension safety filter redacts result keys containing
`auth` as suspected credentials. Name probe variables around it.
