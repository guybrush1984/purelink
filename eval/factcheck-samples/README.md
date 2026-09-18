# Fact-check fixtures

Hand-written posts for the claim-extraction gate (`src/factcheck-prompt.js`)
and the pipeline (`src/factcheck.js`). Not a labeled eval set — these are
smoke tests, one per behaviour worth not breaking.

| file | tests | expected |
|---|---|---|
| `r1-stats-cited.txt` | two statistics, one with a URL in the post | 2 claims, `cited_in_post` + `uncited`, both SUPPORTED |
| `r2-link-in-comments.txt` | "Link in comments" tell | 2 events, both `cited_in_comments` |
| `r3-french.txt` | FR post | 2 statistics, queries written in French |
| `r4-mixed.txt` | one fact buried in noise | 1 event; opinion + anecdote + prediction + advice rejected |
| `r5-false-stat.txt` | a genuinely wrong figure | CONTRADICTED, with the correct figure quoted |
| `r6-unfindable.txt` | plausible but unfindable statistic | UNVERIFIABLE — **never** CONTRADICTED |

`r6` is the safety test. Retrieval returns five topically relevant pages that
say nothing about the claim; anything other than UNVERIFIABLE means the model
is judging from parametric memory, and the feature is unsafe to ship.

The real eval still needs ~20 hand-labeled posts — see the header of
`src/factcheck-prompt.js`.
