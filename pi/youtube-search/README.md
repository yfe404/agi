# pi-youtube-search-apify

Pi extension that registers a `youtube_search` tool backed by
[Apify's YouTube Scraper](https://apify.com/streamers/youtube-scraper)
(`streamers/youtube-scraper` — official Apify-maintained account, ~105k users).
Same actor as [pi-youtube-transcript-apify](../youtube-transcript).

## Requirements

- `APIFY_TOKEN` in the environment (the tool reads it at call time, never logs it)
- Billing: one `Video` event **per returned video** (~$0.0015 each on PLATINUM
  tier, see actor pricing) — a 10-result search costs ~$0.015

## Install

```bash
pi install ~/path/to/agi/pi/youtube-search
```

## Tool

`youtube_search(query, max_results?, sort?, uploaded?)`

- `query` — search terms, as typed into YouTube's search bar
- `max_results` — 1-20 videos (default 10; each is billed)
- `sort` — `relevance` (default), `rating`, `date`, `views`
- `uploaded` — restrict upload window: `hour`, `today`, `week`, `month`, `year`

Returns numbered results: title, duration, URL, channel, view count, publish
date, and a one-line description snippet. The model is instructed to follow up
with `youtube_transcript` when it needs a video's content.

## Env tuning

| Variable | Meaning | Default |
|---|---|---|
| `YOUTUBE_SEARCH_TIMEOUT` | Apify run-sync timeout (s) | 120 |

## Design notes

- Uses the actor's `run-sync-get-dataset-items` endpoint — one HTTP call,
  ~15-30 s latency, no polling.
- Dataset items arrive unordered; results are re-sorted by the actor's `order`
  field to restore YouTube's ranking.
- Shorts and live streams are excluded (`maxResultsShorts: 0`,
  `maxResultStreams: 0`) so `max_results` bounds billing exactly.
- Subtitles are never requested here — that is `youtube_transcript`'s job.
