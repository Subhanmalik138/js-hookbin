#!/usr/bin/env bash
# Sample webhook deliveries to try against a running HookBin server.
# Start the server first:  node cli/hookbin.js serve
# Then run:                bash examples/sample-requests.sh
set -euo pipefail

BASE="${HOOKBIN_URL:-http://localhost:4000}"

echo "== GitHub push event =="
curl -s -X POST "$BASE/webhooks/github" \
  -H 'content-type: application/json' \
  -H 'x-github-event: push' \
  -H 'x-hub-signature-256: sha256=deadbeef' \
  -H 'user-agent: GitHub-Hookshot/1.0' \
  -d '{"ref":"refs/heads/main","repository":{"full_name":"octocat/hello-world"},"pusher":{"name":"octocat"}}'
echo

echo "== Stripe payment event =="
curl -s -X POST "$BASE/webhooks/stripe" \
  -H 'content-type: application/json' \
  -H 'stripe-signature: t=1720000000,v1=abc123' \
  -d '{"type":"payment_intent.succeeded","data":{"object":{"id":"pi_123","amount":2000,"currency":"usd"}}}'
echo

echo "== Plain GET with query string =="
curl -s "$BASE/ping?token=abc&retry=2"
echo

echo "== Binary upload (PNG header bytes) =="
printf '\x89PNG\r\n\x1a\n\xff\x00\x01' | curl -s -X PUT "$BASE/upload" \
  -H 'content-type: application/octet-stream' --data-binary @-
echo

echo "== List what was captured =="
node cli/hookbin.js list --limit 10
