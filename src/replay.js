/**
 * Replay — re-send a captured request to a target URL.
 *
 * `replayRecord(record, target)` sends the record's method, headers and
 * exact body bytes to `target`. The target is the full destination URL
 * (scheme + host + path); the caller decides the path — typically the
 * original path on a local dev server, or an entirely different endpoint
 * when debugging a single handler.
 *
 * Hop-by-hop headers are stripped (host, content-length, connection,
 * transfer-encoding) and recomputed by the client; everything else is
 * forwarded verbatim, including signatures such as `x-hub-signature-256`,
 * which is the point — a replay must look like the original delivery.
 *
 * Implemented on raw `http`/`https` rather than fetch so the method, the
 * header set and the body bytes are fully under our control.
 */
import http from "node:http";
import https from "node:https";
import { encodeBody } from "./request.js";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

export function replayHeaders(record) {
  const headers = {};
  for (const [key, value] of Object.entries(record.headers ?? {})) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}

/**
 * Replay one record. Resolves with { status, headers, body } of the
 * target's response; rejects on network errors and on non-http(s) targets.
 */
export function replayRecord(record, target) {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error(`replay target must be http(s): ${target}`));
  }
  const body = encodeBody(record);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: record.method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: { ...replayHeaders(record), "content-length": body.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("replay timed out after 10s")));
    req.end(body);
  });
}
