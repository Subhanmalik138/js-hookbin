# HookBin — local webhook capture, inspection & replay

Debug webhooks without deploying anything. Point a provider (GitHub, Stripe,
Slack, …) at HookBin running on your machine, watch each delivery land in
real time, inspect the exact headers and body it sent, then replay the
delivery against your local dev server as many times as you need — no more
"push a commit to test the webhook handler" loops.

Zero dependencies, plain Node.js 18+. Everything is stored in one JSONL file
you can grep.

## Quick start

```bash
# Start capturing on http://127.0.0.1:4000
node cli/hookbin.js serve

# In another terminal, send a test webhook:
curl -X POST localhost:4000/webhooks/github \
  -H 'content-type: application/json' \
  -H 'x-hub-signature-256: sha256=deadbeef' \
  -d '{"action":"push","ref":"refs/heads/main"}'

# See what arrived:
node cli/hookbin.js list
node cli/hookbin.js show req_m123abc_7f3k

# Replay it against your app running on :3000:
node cli/hookbin.js replay req_m123abc_7f3k --to http://localhost:3000

# Or browse captures at http://localhost:4000/_hookbin/
```

Or install it globally once (`npm install -g .` from this repo) and use the
`hookbin` command everywhere.

## Commands

| Command | What it does |
| --- | --- |
| `serve [--port 4000] [--host 127.0.0.1] [--dir .hookbin] [--max 500]` | Start the capture server |
| `list [--method POST] [--path /git] [--limit 20] [--json]` | List captures, newest first |
| `show <id> [--json]` | Full detail of one capture |
| `replay <id> --to <base-url>` | Re-send to `<base-url>` + original path & query |
| `replay <id> --exact <url>` | Re-send to one exact URL instead |
| `clear [--force]` | Delete all captures (asks first) |
| `export [--format json\|jsonl] [--out file]` | Dump captures to stdout or a file |

All commands accept `--dir` to use a different capture store (one per
service under test, e.g. `--dir .hookbin-stripe`).

## How it works

- **Capture.** Any request to a path *other* than `/_hookbin/*` is stored:
  method, path, parsed query, all headers, and the body. The sender gets
  `200 { id, receivedAt }` back.
- **Bodies.** Text bodies (JSON, XML, form data) are stored as UTF-8.
  Binary bodies are stored base64 so the log stays valid JSON, and replay
  reconstructs the exact original bytes. Bodies over 1 MiB are truncated
  and flagged (`bodyTruncated: true`).
- **Storage.** One append-only `requests.jsonl` file per store — appending
  a capture is a single O(1) write, a corrupt line is skipped instead of
  killing the log, and the file is greppable with standard tools. The
  store caps itself (default 500 records, `--max` to change it) by evicting
  the oldest captures.
- **Replay.** The original method, headers and body bytes are re-sent to
  the target. Hop-by-hop headers (`host`, `content-length`, `connection`,
  …) are stripped and recomputed; everything else — including signatures
  like `x-hub-signature-256` — is forwarded verbatim, so the replay looks
  like the original delivery.
- **Inspect.** `GET /_hookbin/` serves a plain HTML list of captures and
  `/_hookbin/view/<id>` a detail page; `GET /_hookbin/requests` is the
  JSON API. Reserved paths are never captured themselves.

## Design decisions

1. **Zero dependencies.** A debugging tool should not need `npm install`
   to work, and should keep working years from now. Node's built-in
   `http` module and `node:test` cover everything here.
2. **JSONL, not SQLite.** Append-only lines give O(1) capture writes,
   survive partial corruption, and stay inspectable with `grep`/`jq`.
   The tradeoff — whole-file rewrites on eviction — is fine at webhook
   volumes.
3. **Replay on raw `http`/`https`, not `fetch`.** Full control over the
   method, the exact header set and the body bytes matters more than
   convenience here.
4. **Bodies are escaped in the HTML inspector.** Captured bodies are
   attacker-controlled input; rendering them raw would be a stored-XSS
   hole in the tool built to inspect untrusted webhooks. There is a test
   for this.
5. **The CLI entry lives in `cli/`, not `bin/`.** (Packaging quirk: some
   push tooling skips directories named `bin/`.)

## Running the tests

```bash
npm test   # node:test, 27 tests: store, capture round-trip, replay, CLI
```

## Project layout

```
cli/hookbin.js        entry point (shebang + exit-code plumbing)
src/
  request.js          capture record model: ids, body decode/encode, validation
  store.js            JSONL persistence, filtering, cap/eviction
  capture.js          HTTP server: capture + /_hookbin API
  inspector.js        server-rendered HTML pages (escaped)
  replay.js           re-send a capture to a target URL
  cli.js              argument parsing + command dispatch
tests/                node:test suites (store, capture, replay, cli)
examples/
  sample-requests.sh  curl examples: GitHub push, Stripe event, binary upload
```

## Requirements

Node.js 18 or newer. Nothing else.
