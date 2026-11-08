/**
 * Capture server — the HTTP front door of HookBin.
 *
 * Every request whose path does NOT start with `/_hookbin` is captured:
 * method, path, query, headers and body are stored, and the client gets a
 * small JSON acknowledgement containing the capture id. Reserved paths
 * under `/_hookbin` serve the inspection API and the HTML inspector page
 * instead, and are never captured themselves.
 *
 * Design decisions:
 *   - Node's built-in `http` module only — no framework, no dependencies.
 *   - Bodies are read fully into memory with a 1 MiB cap (see request.js);
 *     a webhook catcher that streams to disk would lose the "inspect the
 *     exact bytes" guarantee for replay.
 *   - The acknowledgement is `200 { id, receivedAt }` rather than echoing
 *     the request back: senders (GitHub, Stripe, ...) only care that the
 *     endpoint accepted the delivery.
 */
import http from "node:http";
import { buildRecord, MAX_BODY_BYTES } from "./request.js";
import { renderDetailPage, renderIndexPage } from "./inspector.js";
import { replayRecord } from "./replay.js";

export const RESERVED_PREFIX = "/_hookbin";

/** Read the request body, honouring the capture cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflowed = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      // Keep reading (so the client is not left hanging) but stop storing
      // past the cap — decodeBody() records the true byte count.
      if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      else overflowed = true;
    });
    req.on("end", () => resolve({ body: Buffer.concat(chunks), overflowed }));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseQuery(search) {
  const query = {};
  for (const [key, value] of new URLSearchParams(search)) query[key] = value;
  return query;
}

/**
 * Handle a reserved `/_hookbin` request. Returns true when handled.
 * Anything else falls through to capture.
 */
async function handleReserved(req, res, store, url) {
  const pathname = url.pathname;

  if (pathname === "/_hookbin" || pathname === "/_hookbin/") {
    const records = await store.list({ limit: 100 });
    return sendHtml(res, 200, renderIndexPage(records)), true;
  }

  if (pathname === "/_hookbin/requests" && req.method === "GET") {
    const records = await store.list({
      method: url.searchParams.get("method") ?? undefined,
      path: url.searchParams.get("path") ?? undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    return sendJson(res, 200, records), true;
  }

  if (pathname === "/_hookbin/requests" && req.method === "DELETE") {
    const cleared = await store.clear();
    return sendJson(res, 200, { cleared }), true;
  }

  const single = pathname.match(/^\/_hookbin\/requests\/([^/]+)$/);
  if (single && req.method === "GET") {
    const record = await store.get(decodeURIComponent(single[1]));
    if (!record) return sendJson(res, 404, { error: "request not found" }), true;
    return sendJson(res, 200, record), true;
  }

  const view = pathname.match(/^\/_hookbin\/view\/([^/]+)$/);
  if (view && req.method === "GET") {
    const record = await store.get(decodeURIComponent(view[1]));
    if (!record) return sendHtml(res, 404, "<h1>Request not found</h1>"), true;
    return sendHtml(res, 200, renderDetailPage(record)), true;
  }

  const replay = pathname.match(/^\/_hookbin\/replay\/([^/]+)$/);
  if (replay && req.method === "POST") {
    const record = await store.get(decodeURIComponent(replay[1]));
    if (!record) return sendJson(res, 404, { error: "request not found" }), true;
    const { body } = await readBody(req);
    let target = null;
    try {
      target = JSON.parse(body.toString("utf8") || "{}").target ?? null;
    } catch {
      return sendJson(res, 400, { error: "body must be JSON with a target URL" }), true;
    }
    if (typeof target !== "string" || !target.startsWith("http")) {
      return sendJson(res, 400, { error: "target must be an http(s) URL" }), true;
    }
    try {
      const result = await replayRecord(record, target);
      return sendJson(res, 200, result), true;
    } catch (err) {
      return sendJson(res, 502, { error: `replay failed: ${err.message}` }), true;
    }
  }

  return false;
}

/**
 * Create the capture server. `store` is a RequestStore; `onCapture` is an
 * optional hook called with each stored record (used by the CLI to log).
 */
export function createCaptureServer(store, { onCapture } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://hookbin.local");
      if (url.pathname.startsWith(RESERVED_PREFIX)) {
        const handled = await handleReserved(req, res, store, url);
        if (handled) return;
        // Unknown reserved path: 404, never captured.
        return sendJson(res, 404, { error: "unknown HookBin endpoint" });
      }

      const { body } = await readBody(req);
      const record = buildRecord({
        method: req.method,
        path: url.pathname,
        query: parseQuery(url.search),
        headers: req.headers,
        bodyBuffer: body,
      });
      await store.add(record);
      onCapture?.(record);
      sendJson(res, 200, { id: record.id, receivedAt: record.receivedAt });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
  });
  return server;
}

/** Start listening; resolves with { server, port } once bound. */
export function listen(server, { host = "127.0.0.1", port = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}
