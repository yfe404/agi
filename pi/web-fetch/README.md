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

## Notes

- The ghost-browser session stays alive after a fetch; its daemon reuses it for
  subsequent fetches and auto-releases after ~10 idle minutes. `ghost-browser stop`
  releases immediately.
- Verified: static HTML, PDF conversion, and browser tier passing
  deviceandbrowserinfo.com's bot check ("You are human!").
- Pairs with [`pi/web-search`](../web-search/): search returns snippets,
  web_fetch reads the chosen result.
