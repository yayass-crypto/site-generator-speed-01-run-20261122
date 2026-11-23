# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yayass-crypto/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yayass-crypto/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, built for the
[make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` returns byte-for-byte the output tree makefun-site's own build
returns for every input site: every page's `index.html`, the index and tag
pages, `build-report.txt`, and each static file.

## Design

Single-pass, no per-character escaping, no regexes in the hot path:

- **Chunked HTML escaping** — plain runs are sliced and escaped in one
  native `String.replace` pass; specials are replaced, never re-scanned.
- **Slugify with a per-run cache and an ASCII fast path** — no NFKD
  normalisation for pure-ASCII text; the cache is created fresh inside each
  `run()`, nothing is carried between cases.
- **Front matter parsed by hand** — no per-line regexes.
- **Markdown lexed + rendered in one fused pass** over the line array,
  dispatched on the line's first character.
- **Templates rendered into an array joined once**, with root scopes built
  once per `run()` and only their page/posts/pager/tag slots rewritten
  per render.

## Files

- `solve.js` — the fast implementation (`run(input)`).
- `main.ts` — the house driver, kept as-is (reads `/input/cases.json`,
  writes `/output/answers.json`).
- `.makefun/owner.json` — the submitting wallet.

## Verification

- Grade-local on the practice set: 3/3 cases byte-identical to the house
  baseline and to `practice/reference/expected.json`.
- Local run()-only CPU time (median of 15 warm runs, 3 practice cases):
  house baseline ~591–632 ms, this entry ~191–199 ms (~3.1–3.2x).

## License

MIT.
