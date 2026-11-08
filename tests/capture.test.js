import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RequestStore } from "../src/store.js";
import { createCaptureServer, listen } from "../src/capture.js";

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hookbin-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Start a capture server on an ephemeral port; closed automatically. */
async function startServer(t, dir) {
  const store = new RequestStore(dir);
  const server = createCaptureServer(store);
  const { port } = await listen(server, { port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { store, base: `http://127.0.0.1:${port}` };
}

test("capture: POST JSON is stored and acknowledged with its id", async (t) => {
  const { store, base } = await startServer(t, await tmpDir(t));
  const res = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
    body: JSON.stringify({ action: "push", ref: "refs/heads/main" }),
  });
  assert.equal(res.status, 200);
  const ack = await res.json();
  assert.match(ack.id, /^req_/);

  const stored = await store.get(ack.id);
  assert.equal(stored.method, "POST");
  assert.equal(stored.path, "/webhooks/github");
  assert.equal(stored.headers["x-hub-signature-256"], "sha256=deadbeef");
  assert.equal(JSON.parse(stored.body).action, "push");
});

test("capture: query strings are parsed and GETs with no body are stored", async (t) => {
  const { store, base } = await startServer(t, await tmpDir(t));
  await fetch(`${base}/ping?token=abc&retry=2`);
  const [record] = await store.list();
  assert.equal(record.method, "GET");
  assert.deepEqual(record.query, { token: "abc", retry: "2" });
  assert.equal(record.body, "");
  assert.equal(record.bodyBytes, 0);
});

test("capture: reserved /_hookbin paths are served, never captured", async (t) => {
  const { store, base } = await startServer(t, await tmpDir(t));
  await fetch(`${base}/real-hook`, { method: "POST", body: "x" });

  const listRes = await fetch(`${base}/_hookbin/requests`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, "/real-hook");

  const single = await fetch(`${base}/_hookbin/requests/${listed[0].id}`);
  assert.equal(single.status, 200);

  const missing = await fetch(`${base}/_hookbin/requests/req_nope`);
  assert.equal(missing.status, 404);

  const html = await (await fetch(`${base}/_hookbin/`)).text();
  assert.match(html, /HookBin/);
  assert.match(html, /\/real-hook/);

  const unknown = await fetch(`${base}/_hookbin/nope`);
  assert.equal(unknown.status, 404);
  assert.equal(await store.count(), 1); // none of the reserved calls were stored
});

test("capture: list API filters by method and path", async (t) => {
  const { base } = await startServer(t, await tmpDir(t));
  await fetch(`${base}/a`, { method: "POST", body: "1" });
  await fetch(`${base}/b`, { method: "GET" });
  const filtered = await (await fetch(`${base}/_hookbin/requests?method=GET`)).json();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].path, "/b");
});

test("capture: DELETE /_hookbin/requests clears the store", async (t) => {
  const { store, base } = await startServer(t, await tmpDir(t));
  await fetch(`${base}/x`, { method: "POST", body: "1" });
  const res = await fetch(`${base}/_hookbin/requests`, { method: "DELETE" });
  assert.deepEqual(await res.json(), { cleared: 1 });
  assert.equal(await store.count(), 0);
});

test("capture: binary bodies are stored base64 and replayable byte-for-byte", async (t) => {
  const { store, base } = await startServer(t, await tmpDir(t));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
  await fetch(`${base}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: png,
  });
  const [record] = await store.list();
  assert.equal(record.bodyEncoding, "base64");
  assert.deepEqual(Buffer.from(record.body, "base64"), png);
});
