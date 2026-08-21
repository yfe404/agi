# pi-youtube-transcript-apify

Pi extension that registers a `youtube_transcript` tool backed by
[Apify's YouTube Scraper](https://apify.com/streamers/youtube-scraper)
(`streamers/youtube-scraper` — official Apify-maintained account, ~105k users).

## Requirements

- `APIFY_TOKEN` in the environment (the tool reads it at call time, never logs it)
- Billing: one `Video` event per call (~$0.0015 on PLATINUM tier, see actor pricing)

## Install

```bash
pi install ~/path/to/agi/pi/youtube-transcript
```

## Tool

`youtube_transcript(url, language?, timestamps?)`

- `url` — YouTube watch/youtu.be/shorts URL, or a bare 11-char video ID
- `language` — subtitle language: `any`, `en` (default), `de`, `es`, `fr`, `it`,
  `ja`, `ko`, `nl`, `pt`, `ru`
- `timestamps` — `true` returns SRT with timestamps; default is plain text

Returns video metadata (title, channel, duration, publish date, views) followed
by the transcript. Human-made captions are preferred over auto-generated ones
when both exist. Videos without captions return metadata plus a clear
"no transcript" notice. Transcripts are truncated at 80k characters.

## Env tuning

| Variable | Meaning | Default |
|---|---|---|
| `YOUTUBE_TRANSCRIPT_TIMEOUT` | Apify run-sync timeout (s) | 120 |

## Design notes

- Uses the actor's `run-sync-get-dataset-items` endpoint — one HTTP call,
  ~10-30 s latency, no polling.
- Chosen over transcript-specific actors (e.g. `pintostudio/youtube-transcript-scraper`)
  because `streamers/youtube-scraper` is maintained by Apify's official account,
  has by far the largest user base, and is cheaper per video.
- The actor returns subtitle content inline in the dataset item
  (`subtitles[].plaintext` or `subtitles[].srt`), so no key-value-store fetch
  is needed.
- `maxResults: 1` is always sent so a channel/playlist URL passed by mistake
  cannot fan out into a large (billed) crawl.
