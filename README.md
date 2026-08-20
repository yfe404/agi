# agi

Personal collection of agent skills, pi extensions, and modules.

## Contents

| Path | What |
|---|---|
| [`pi/codex-rotate`](pi/codex-rotate/) | Pi extension: multi-account round-robin rotation for OpenAI Codex |
| [`pi/web-search`](pi/web-search/) | Pi extension: `web_search` tool backed by Apify's Google Search Scraper |

## External projects

Live in their own repos; listed here as part of the toolkit.

| Repo | What |
|---|---|
| [ghost-browser](https://github.com/yfe404/ghost-browser) | Apify-native stealth Chromium harness for coding agents (raw CDP, Python). Install: `uv tool install --python 3.12 git+https://github.com/yfe404/ghost-browser.git`; agent skill via `ghost-browser skill` |

## Installing a pi extension from this repo

Clone the repo and install by local path:

```bash
pi install ~/path/to/agi/pi/codex-rotate
```

Local-path installs are referenced in place (not copied), so `git pull` +
`/reload` picks up updates.
