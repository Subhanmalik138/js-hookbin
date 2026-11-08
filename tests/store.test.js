import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RequestStore } from "../src/store.js";
import {
  buildRecord,
  decodeBody,
  encodeBody,
  isValidRecord,
  newRequestId,
} from "../src/request.js";

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hookbin-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function sampleRecord(overrides = {}) {
  return buildRecord({
    method: "POST",
    path: "/webhooks/github",
    query: { ref: "main" },
    headers: { "content-type": "application/json", "x-hub-signature": "sha256=abc" },
    bodyBuffer: Buffer.from(JSON.stringify({ action: "push" })),
    ...overrides,
  });
}

test("request ids are unique and time-ordered", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
  assert.equal(ids.size, 100);
  assert.ok([...ids].every((id) => id.startsWith("req_")));
});

test("decodeBody keeps text bodies as utf-8 and flags binary as base64", () => {
  const text = decodeBody(Buffer.from('{"a":1}', "utf8"));
  assert.equal(text.bodyEncoding, "utf8");
  assert.equal(text.body, '{"a":1}');
  assert.equal(text.bodyTruncated, false);

  const binary = decodeBody(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
  assert.equal(binary.bodyEncoding, "base64");
  assert.equal(binary.bodyBytes, 6);
});

test("decodeBody truncates bodies over the cap and keeps exact bytes on replay", () => {
  const decoded = decodeBody(Buffer.from("x".repeat(50)), 10);
  assert.equal(decoded.bodyTruncated, true);
  assert.equal(decoded.bodyBytes, 50);
  assert.equal(decoded.body.length, 10);

  const binary = buildRecord({
    method: "POST",
    path: "/bin",
    query: {},
    headers: {},
    bodyBuffer: Buffer.from([0x89, 0x50, 0xff]),
  });
  assert.deepEqual(encodeBody(binary), Buffer.from([0x89, 0x50, 0xff]));
});

test("isValidRecord rejects malformed lines", () => {
  assert.equal(isValidRecord(null), false);
  assert.equal(isValidRecord({ id: "req_x" }), false);
  assert.equal(isValidRecord(sampleRecord()), true);
  const bad = sampleRecord();
  bad.receivedAt = "not-a-date";
  assert.equal(isValidRecord(bad), false);
});

test("store: add, list newest-first, get, and count", async (t) => {
  const store = new RequestStore(await tmpDir(t));
  assert.equal(await store.count(), 0);

  const first = await store.add(sampleRecord());
  const second = await store.add(
    sampleRecord({ method: "GET", path: "/ping", bodyBuffer: Buffer.alloc(0) }),
  );

  assert.equal(await store.count(), 2);
  const listed = await store.list();
  assert.equal(listed[0].id, second.id); // newest first
  assert.equal(listed[1].id, first.id);
  assert.deepEqual(await store.get(first.id), first);
  assert.equal(await store.get("req_missing"), null);
});

test("store: list filters by method and path substring", async (t) => {
  const store = new RequestStore(await tmpDir(t));
  await store.add(sampleRecord({ method: "POST", path: "/webhooks/github" }));
  await store.add(sampleRecord({ method: "POST", path: "/webhooks/stripe" }));
  await store.add(sampleRecord({ method: "GET", path: "/webhooks/github" }));

  assert.equal((await store.list({ method: "POST" })).length, 2);
  assert.equal((await store.list({ path: "stripe" })).length, 1);
  assert.equal((await store.list({ method: "GET", path: "stripe" })).length, 0);
  assert.equal((await store.list({ limit: 2 })).length, 2);
});

test("store: records survive a reload and corrupt lines are skipped", async (t) => {
  const dir = await tmpDir(t);
  const store = new RequestStore(dir);
  const kept = await store.add(sampleRecord());
  await fs.appendFile(path.join(dir, "requests.jsonl"), "this is not json\n");
  await fs.appendFile(path.join(dir, "requests.jsonl"), '{"id": "broken"}\n');

  const reopened = new RequestStore(dir);
  const listed = await reopened.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, kept.id);
});

test("store: cap evicts the oldest records", async (t) => {
  const store = new RequestStore(await tmpDir(t), 3);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await store.add(sampleRecord({ path: `/n${i}` }))).id);
  }
  assert.equal(await store.count(), 3);
  const listed = await store.list();
  assert.deepEqual(
    listed.map((r) => r.id),
    [ids[4], ids[3], ids[2]],
  );
  // Eviction must also be reflected on disk, not just in memory.
  const reopened = new RequestStore(await (async () => store.dir)());
  assert.equal(await reopened.count(), 3);
});

test("store: clear removes everything and reports the count", async (t) => {
  const store = new RequestStore(await tmpDir(t));
  await store.add(sampleRecord());
  await store.add(sampleRecord());
  assert.equal(await store.clear(), 2);
  assert.equal(await store.count(), 0);
  assert.deepEqual(await store.list(), []);
});
