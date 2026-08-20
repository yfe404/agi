# pi-web-search-apify

Pi extension that registers a `web_search` tool backed by
[Apify's Google Search Scraper](https://apify.com/apify/google-search-scraper) —
real Google SERP results, not a search API index.

## Requirements

- `APIFY_TOKEN` in the environment (the tool reads it at call time, never logs it)
- Billing: one `search-page-scraped` event per call (~$ per SERP page, see actor pricing)

## Install

```bash
pi install ~/path/to/agi/pi/web-search
```

## Tool

`web_search(query, max_results?, country?)`

- `query` — Google operators supported (`site:`, `filetype:`, `"exact"`, ...)
- `max_results` — 1-20 organic results (default 10)
- `country` — ISO alpha-2 for localized results (e.g. `de`)

Returns numbered organic results (title, URL, snippet), top "people also ask"
questions, and related queries. Snippets only — the model is instructed to
fetch a URL via bash when a snippet is not enough.

## Env tuning

| Variable | Meaning | Default |
|---|---|---|
| `WEB_SEARCH_COUNTRY` | default country code | none (global) |
| `WEB_SEARCH_TIMEOUT` | Apify run-sync timeout (s) | 120 |

## Design notes

- Uses the actor's `run-sync-get-dataset-items` endpoint — one HTTP call,
  ~10-15 s latency, no polling.
- Deliberately snippet-only: page fetching is left to bash/curl or
  [ghost-browser](https://github.com/yfe404/ghost-browser) for JS-heavy or
  protected pages.
