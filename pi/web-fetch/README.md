# pi-web-fetch

Pi extension that registers a `web_fetch` tool: fetch any URL and return clean
Markdown, with a stealth-browser fallback for hard pages.

## Pipeline

```
web_fetch(url)
  ├─ tier 1: static HTTP fetch ──► markitdown ──► Markdown
  │     (HTML, PDF, docx, xlsx, pptx, csv, json, ...)
  │
  └─ tier 2: ghost-browser (stealth Chromium on Apify, raw CDP)
        renders the page ──► DOM HTML ──► markitdown ──► Markdown
        used when render=true, or automatically when tier 1 is
        blocked (401/403/407/429/5xx) or returns near-empty HTML
```

## Requirements

| Dependency | Install | Needed for |
|---|---|---|
| [markitdown](https://github.com/microsoft/markitdown) | `uv tool install "markitdown[all]"` | all conversions |
| [ghost-browser](https://github.com/yfe404/ghost-browser) | `uv tool install --python 3.12 git+https://github.com/yfe404/ghost-browser.git` + `APIFY_TOKEN` | browser tier only |

## Install

```bash
pi install ~/path/to/agi/pi/web-fetch
```

## Tool

`web_fetch(url, render?, wait_seconds?, max_chars?, offset?)`

- `render` — force the browser tier
- `wait_seconds` — JS settle time after navigation in browser mode (default 3)
- `max_chars` / `offset` — pagination for long documents (default 20 000 chars;
  truncated results include the offset to continue from)
- `refresh` — bypass the cache and re-fetch
- `text_only` — strip links/images, keep display text (~50% smaller on
  link-dense pages like news indexes)
- `scroll` — browser mode: scroll to the bottom up to N times (1.5s pause
  each) to load infinite-scroll content; stops early when the page height
  stabilizes. Implies `render=true`. Measured on a subreddit feed:
  7× more content with `scroll=5`.

## Pagination consistency

Converted Markdown is cached per URL (in-memory LRU, 20 entries, ~10 min TTL),
so `offset` calls slice the **same** document instead of re-fetching and
re-rendering a page that may have changed between calls. This matters for the
browser tier, where a re-render is slow and dynamic pages are not stable.
Use `refresh=true` to force a fresh fetch.

When the fetch used anything other than a plain static request (browser
fallback, forced render, or cache hit), the returned content starts with a
`[fetched via ...]` provenance line so the model knows what it is reading.

## Notes

- The ghost-browser session stays alive after a fetch; its daemon reuses it for
  subsequent fetches and auto-releases after ~10 idle minutes. `ghost-browser stop`
  releases immediately.
- Verified: static HTML, PDF conversion, and browser tier passing
  deviceandbrowserinfo.com's bot check ("You are human!").
- Pairs with [`pi/web-search`](../web-search/): search returns snippets,
  web_fetch reads the chosen result.
