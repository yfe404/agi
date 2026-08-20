# pi-codex-rotate

Pi extension for using multiple OpenAI Codex (ChatGPT Plus/Pro) accounts with
automatic round-robin rotation and rate-limit failover.

## How it works

- Registers extra `openai-codex-2`, `openai-codex-3`, ... providers that clone
  the built-in `openai-codex` provider. Each gets its own OAuth credentials in
  `~/.pi/agent/auth.json` (keyed by provider id), same models, same API.
- **Per-session round-robin**: each new session advances to the next
  available account, spreading load across accounts.
- **Rate-limit failover**: when the active account hits a rate limit mid-run,
  it is put on cooldown (default 30 min), the extension switches to the next
  available account and re-sends your last prompt.

## Install

From the repo root (local path install, no copying — edits apply on `/reload`):

```bash
pi install ~/path/to/agi/pi/codex-rotate
```

## Setup (3 accounts)

```
/codex accounts 3
/login openai-codex        # account 1 (skip if already logged in)
/login openai-codex-2      # account 2
/login openai-codex-3      # account 3
/codex status
```

## Commands

```
/codex               status: accounts, auth, cooldowns, active account
/codex accounts N    set total number of Codex accounts (1-20)
/codex switch        rotate to the next available account now
/codex cooldown M    set cooldown minutes after a rate limit (default 30)
```

## State

`~/.pi/agent/agi-codex.json` — account count, cooldown, round-robin pointer,
per-account cooldown timestamps. Delete it to reset.

## Non-goals

Unlike [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), this
extension deliberately supports exactly one provider (Codex), one pool, and
one strategy (round-robin with cooldown). No chains, presets, schedules, or
per-project affinity.
