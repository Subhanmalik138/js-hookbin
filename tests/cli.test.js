import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { escapeHtml, renderDetailPage, renderIndexPage } from "../src/inspector.js";
import { buildRecord } from "../src/request.js";
import { parseFlags, run } from "../src/cli.js";

function sample(overrides = {}) {
  return buildRecord({
    method: "POST",
    path: "/webhooks/github",
    query: {},
    headers: { "content-type": "application/json" },
    bodyBuffer: Buffer.from(JSON.stringify({ action: "push" })),
    ...overrides,
  });
}

test("inspector: escapes attacker-controlled bodies (stored XSS)", () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script> & \'quotes\''),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;",
  );
  const evil = sample({ bodyBuffer: Buffer.from('<script>alert("pwned")</script>') });
  const html = renderDetailPage(evil);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

test("inspector: index page lists records and links to detail pages", () => {
  const html = renderIndexPage([sample()]);
  assert.match(html, /\/webhooks\/github/);
  assert.match(html, /\/_hookbin\/view\/req_/);
  assert.doesNotMatch(html, /No requests captured yet/);
  assert.match(renderIndexPage([]), /No requests captured yet/);
});

test("inspector: detail page pretty-prints JSON bodies", () => {
  const html = renderDetailPage(sample());
  // Quotes are HTML-escaped in the rendered page, so match the escaped form.
  assert.match(html, /&quot;action&quot;: &quot;push&quot;/);
  assert.match(html, /content-type/);
});

test("cli: parseFlags splits flags from positionals", () => {
  assert.deepEqual(parseFlags(["--port", "4000", "--json", "show", "req_1"]), {
    flags: { port: "4000", json: true },
    positional: ["show", "req_1"],
  });
});

test("cli: --help and --version do not touch the store", async () => {
  assert.match((await run(["--help"])).stdout, /HookBin/);
  assert.match((await run(["--version"])).stdout, /hookbin \d+\.\d+\.\d+/);
  assert.equal((await run(["bogus-command"])).code, 1);
});

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hookbin-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("cli: list/show/export round-trip through the real store", async (t) => {
  const dir = await tmpDir(t);
  const { RequestStore } = await import("../src/store.js");
  const store = new RequestStore(dir);
  const record = await store.add(sample());

  const listed = await run(["list", "--dir", dir]);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /\/webhooks\/github/);

  const shown = await run(["show", record.id, "--dir", dir]);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /"action": "push"|action/);

  const exported = await run(["export", "--dir", dir, "--format", "json"]);
  assert.equal(exported.code, 0);
  assert.equal(JSON.parse(exported.stdout).length, 1);

  const missing = await run(["show", "req_nope", "--dir", dir]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no captured request/);
});

test("cli: clear --force empties the store and reports the count", async (t) => {
  const dir = await tmpDir(t);
  const { RequestStore } = await import("../src/store.js");
  const store = new RequestStore(dir);
  await store.add(sample());
  await store.add(sample());

  const cleared = await run(["clear", "--dir", dir, "--force"]);
  assert.equal(cleared.code, 0);
  assert.match(cleared.stdout, /Cleared 2/);
  // The test's store instance cached its records; reload from disk to verify.
  await store.load();
  assert.equal(await store.count(), 0);
});

test("cli: replay --to rebuilds the original path on the target", async (t) => {
  const dir = await tmpDir(t);
  const { RequestStore } = await import("../src/store.js");
  const store = new RequestStore(dir);
  const record = await store.add(
    sample({ path: "/hooks/stripe", query: { live: "true" } }),
  );

  const http = await import("node:http");
  let received = null;
  const target = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      received = req.url;
      res.end("ok");
    });
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const targetBase = `http://127.0.0.1:${target.address().port}`;

  const result = await run(["replay", record.id, "--dir", dir, "--to", targetBase]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /response: 200/);
  assert.equal(received, "/hooks/stripe?live=true");

  const noTarget = await run(["replay", record.id, "--dir", dir]);
  assert.equal(noTarget.code, 1);
  assert.match(noTarget.stderr, /--to/);
});
