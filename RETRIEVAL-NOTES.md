# Retrieval Notes — Ollama web_search / web_fetch

Measured 2026-09-08 with a real `OLLAMA_API_KEY`. Both endpoints live on
`https://ollama.com` only; the local daemon (0.20.3) 404s on every spelling
(`api/web_search`, `api/websearch`, `api/web_fetch`, `api/search`,
`v1/web_search`, `api/tools`). Auth is `Authorization: Bearer $OLLAMA_API_KEY`,
a *different* credential from `ollama signin` — signin uses the ed25519 keypair
in `~/.ollama/` and covers model inference only.

## web_search

`POST /api/web_search` — `{query, max_results}`, cap 10, default 5.
Returns `{results: [{title, url, content}]}`.

**`content` is not a snippet.** Observed 1.5K–11K chars per result. Five
results is ~25K chars / ~7K tokens — too much to feed raw into a verdict call.
Rank or truncate before spending them.

Quality is good on real claims. The attribution claim from
`detection-tests/samples/12-niels.txt` ("Thomas Wolf … asking the question is
the hard part") returned the Fortune interview and four corroborating pieces
in the top 5.

## web_fetch

`POST /api/web_fetch` — `{url}`. Returns `{title, content, links}`.

### It fails silently

A blocked or failed fetch returns **HTTP 200 with `content: ""` and
`title: ""`**, not an error. Always check length; never treat a 200 as success.

### Two distinct failure modes

**Hard block** — paywalled / bot-walled publishers, deterministic:

| site | 5 attempts |
|---|---|
| `fortune.com` | 0 0 0 0 0 |
| `finance.yahoo.com` | 0 0 0 0 0 |

**Transient flake** — `en.wikipedia.org` returned 0 once, then 147322 chars on
3/3 retries. Retry once before concluding anything.

Working sites returned 4–6K chars (`reuters.com`, `arxiv.org`,
`briefing.rdcl.is`).

### search and fetch are independent extractions

Same URL, same run: search `content` 1537 chars, fetch `content` 1375 chars,
not identical and neither a superset of the other.

This matters more than it looks: **when fetch is hard-blocked, search may still
carry the evidence text.** `fortune.com` fetches to 0 but appears in search
results with 3598 chars of content. So search is a real fallback for
paywalled sources, not just a discovery step.

## lnkd.in resolution — solved, two hops

`web_fetch` does **not** follow LinkedIn's shortener. It returns the
interstitial:

```
"This link will take you to a page that's not on LinkedIn"
"Because this is an external link, we're unable to verify it for safety."
```

But the target is in the response's `links`:

```js
links[0] === "https://www.reuters.com/business/media-telecom/white-house-..."
links[1] === "https://www.linkedin.com/help/linkedin/answer/a1341680?trk=..."
```

So: fetch the `lnkd.in` URL, take the first `links` entry that is not
`linkedin.com`, fetch that. Two calls.

Note this is only needed for bare pastes. Most feed links come wrapped as
`linkedin.com/safety/go/?url=<encoded>`, which decodes straight to the real
target with no network call — see `DOM-NOTES.md`.

## Consequences for the fact-checker

- Budget per claim is search-dominated, not LLM-dominated. Rank before reading.
- Every retrieval needs a reachable/unreachable state. A source that cannot be
  fetched is `UNVERIFIABLE`, never `CONTRADICTED`.
- Retry once on empty content before giving up; twice is wasted on hard blocks.
- Prefer search content over a second fetch when the URL already came from a
  search result — the fetch adds a call and may return less.
