import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { buildRecord } from "../src/request.js";
import { replayRecord, replayHeaders } from "../src/replay.js";

/** A target server that records the last request it received. */
async function startTarget(t) {
  const state = { last: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.last = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, base: `http://127.0.0.1:${server.address().port}` };
}

function githubPushRecord() {
  return buildRecord({
    method: "POST",
    path: "/webhooks/github",
    query: { ref: "main" },
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=deadbeef",
      "user-agent": "GitHub-Hookshot/1.0",
    },
    bodyBuffer: Buffer.from(JSON.stringify({ action: "push" })),
  });
}

test("replay: target receives the original method, path, headers and body", async (t) => {
  const { state, base } = await startTarget(t);
  const record = githubPushRecord();
  const result = await replayRecord(record, `${base}/webhooks/github?ref=main`);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).ok, true);

  assert.equal(state.last.method, "POST");
  assert.equal(state.last.url, "/webhooks/github?ref=main");
  assert.equal(state.last.headers["x-hub-signature-256"], "sha256=deadbeef");
  assert.equal(state.last.headers["user-agent"], "GitHub-Hookshot/1.0");
  assert.equal(state.last.body.toString("utf8"), JSON.stringify({ action: "push" }));
});

test("replay: binary bodies arrive byte-for-byte", async (t) => {
  const { state, base } = await startTarget(t);
  const record = buildRecord({
    method: "PUT",
    path: "/upload",
    query: {},
    headers: { "content-type": "application/octet-stream" },
    bodyBuffer: Buffer.from([0x89, 0x50, 0xff, 0x00, 0x01]),
  });
  await replayRecord(record, `${base}/upload`);
  assert.deepEqual([...state.last.body], [0x89, 0x50, 0xff, 0x00, 0x01]);
});

test("replay: hop-by-hop headers are stripped, content-length is recomputed", () => {
  const headers = replayHeaders({
    headers: {
      host: "old.example.com",
      connection: "keep-alive",
      "content-length": "9999",
      "x-custom": "keep-me",
    },
  });
  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["x-custom"], "keep-me");
});

test("replay: unreachable target rejects with a useful error", async () => {
  await assert.rejects(
    () => replayRecord(githubPushRecord(), "http://127.0.0.1:1/nowhere"),
    /ECONNREFUSED/,
  );
  await assert.rejects(
    () => replayRecord(githubPushRecord(), "ftp://example.com/x"),
    /must be http\(s\)/,
  );
});
