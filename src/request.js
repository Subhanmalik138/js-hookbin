/**
 * Captured request record: the domain model of HookBin.
 *
 * A record is a plain JSON object so it can be written to a JSONL log
 * without any serialisation layer:
 *
 *   {
 *     id:            "req_m123abc_7f3k",   // sortable-ish, unique
 *     receivedAt:    "2026-11-08T14:00:00.000Z",
 *     method:        "POST",
 *     path:          "/webhooks/github",
 *     query:         { ref: "main" },      // parsed query string
 *     headers:       { "content-type": "application/json", ... },
 *     contentType:   "application/json",
 *     body:          "{...}" | null,      // utf-8 text, or base64 when binary
 *     bodyEncoding:  "utf8" | "base64",
 *     bodyTruncated: false,               // true when the body hit the cap
 *     bodyBytes:     123                  // bytes actually received
 *   }
 */

/** Maximum body kept per request (1 MiB). Anything larger is truncated. */
export const MAX_BODY_BYTES = 1024 * 1024;

let counter = 0;

/**
 * Generate a request id. Base-36 timestamp keeps ids roughly time-ordered,
 * the counter disambiguates same-millisecond captures, and a random suffix
 * makes ids unique across restarts (the counter resets per process).
 */
export function newRequestId(now = new Date()) {
  counter = (counter + 1) % 46656; // 36^3, rolls over harmlessly
  const time = now.getTime().toString(36);
  const seq = counter.toString(36).padStart(3, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `req_${time}_${seq}${rand}`;
}

/**
 * Decode a raw request body for storage.
 *
 * Text bodies (valid UTF-8, which covers JSON, XML, form data and plain
 * text) are stored as-is. Binary bodies are stored base64 so the JSONL log
 * stays valid JSON and replay can reconstruct the exact bytes.
 *
 * Returns { body, bodyEncoding, bodyTruncated, bodyBytes }.
 */
export function decodeBody(buffer, maxBytes = MAX_BODY_BYTES) {
  const bodyBytes = buffer.length;
  const truncated = bodyBytes > maxBytes;
  const kept = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const asText = kept.toString("utf8");
  // Round-trip check: if the bytes are not valid UTF-8, toString() replaces
  // bad sequences with U+FFFD and the round trip no longer matches.
  const isText = Buffer.from(asText, "utf8").equals(kept);
  return {
    body: isText ? asText : kept.toString("base64"),
    bodyEncoding: isText ? "utf8" : "base64",
    bodyTruncated: truncated,
    bodyBytes,
  };
}

/** Reconstruct the exact bytes that were captured, for replay. */
export function encodeBody(record) {
  if (record.body === null || record.body === undefined) return Buffer.alloc(0);
  return record.bodyEncoding === "base64"
    ? Buffer.from(record.body, "base64")
    : Buffer.from(record.body, "utf8");
}

/** Build a record from the pieces the HTTP server observed. */
export function buildRecord({ method, path, query, headers, bodyBuffer, receivedAt = new Date() }) {
  const decoded = decodeBody(bodyBuffer ?? Buffer.alloc(0));
  return {
    id: newRequestId(receivedAt),
    receivedAt: receivedAt.toISOString(),
    method: method.toUpperCase(),
    path,
    query,
    headers,
    contentType: headers["content-type"] ?? null,
    ...decoded,
  };
}

/**
 * Validate a record loaded back from disk. The JSONL log is append-only and
 * written by this program, but a user can hand-edit it — never trust a line
 * blindly. Returns true only for records with the fields the rest of the
 * code depends on.
 */
export function isValidRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.receivedAt === "string" &&
    !Number.isNaN(Date.parse(value.receivedAt)) &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    value.query !== null &&
    typeof value.query === "object" &&
    value.headers !== null &&
    typeof value.headers === "object" &&
    (value.body === null || typeof value.body === "string") &&
    (value.bodyEncoding === "utf8" || value.bodyEncoding === "base64") &&
    typeof value.bodyBytes === "number"
  );
}
