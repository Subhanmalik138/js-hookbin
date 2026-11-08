/**
 * Inspector — tiny server-rendered HTML pages for `/_hookbin`.
 *
 * No client-side JavaScript and no assets: the pages are plain HTML + CSS
 * so they work from curl, from a phone browser, and from any webhook
 * sender's "open in browser" link. Every value interpolated into the HTML
 * is escaped — captured bodies are attacker-controlled input, so rendering
 * them raw would be a stored-XSS hole in the very tool meant to inspect
 * untrusted webhooks.
 */

/** Escape the five characters that can break out of HTML text/attributes. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto;
         padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h1 span { color: #666; font-weight: 400; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #ddd;
           font-size: .9rem; vertical-align: top; }
  th { color: #666; font-weight: 600; }
  .method { font-weight: 700; }
  .method.GET { color: #0a7d33; } .method.POST { color: #0b5cad; }
  .method.PUT { color: #8a5a00; } .method.DELETE { color: #b3261e; }
  a { color: #0b5cad; text-decoration: none; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap;
        word-break: break-word; }
  .meta { color: #666; font-size: .85rem; }
  .empty { color: #666; }
  .back { display: inline-block; margin-bottom: 1rem; }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body>${body}</body></html>`;
}

function prettyBody(record) {
  if (record.body === null || record.body === undefined) return "(empty body)";
  if (record.bodyEncoding === "base64") return `(binary body, ${record.bodyBytes} bytes, base64)`;
  if (record.contentType?.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(record.body), null, 2);
    } catch {
      return record.body; // invalid JSON: show it raw, it may be the bug
    }
  }
  return record.body;
}

export function renderIndexPage(records) {
  const rows = records
    .map(
      (r) => `<tr>
  <td><span class="method ${escapeHtml(r.method)}">${escapeHtml(r.method)}</span></td>
  <td><a href="/_hookbin/view/${encodeURIComponent(r.id)}">${escapeHtml(r.path)}</a></td>
  <td>${escapeHtml(r.receivedAt)}</td>
  <td>${r.bodyBytes} B</td>
</tr>`,
    )
    .join("\n");
  const table = records.length
    ? `<table><thead><tr><th>Method</th><th>Path</th><th>Received</th><th>Body</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : `<p class="empty">No requests captured yet. Send one to any path on this server,
e.g. <code>curl -X POST localhost:4000/webhooks/github -d '{"hello":"world"}'</code></p>`;
  return page(
    "HookBin — captured requests",
    `<h1>HookBin <span>— captured requests</span></h1>
<p class="meta">${records.length} request(s) shown (newest first). JSON API:
<a href="/_hookbin/requests">/_hookbin/requests</a></p>${table}`,
  );
}

export function renderDetailPage(record) {
  const headerRows = Object.entries(record.headers)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("\n");
  const query = Object.keys(record.query).length
    ? `<h2>Query</h2><pre>${escapeHtml(JSON.stringify(record.query, null, 2))}</pre>`
    : "";
  const truncated = record.bodyTruncated
    ? `<p class="meta">Body truncated at 1 MiB (${record.bodyBytes} bytes received).</p>`
    : "";
  return page(
    `HookBin — ${record.method} ${record.path}`,
    `<a class="back" href="/_hookbin/">&larr; All requests</a>
<h1><span class="method ${escapeHtml(record.method)}">${escapeHtml(record.method)}</span>
${escapeHtml(record.path)}</h1>
<p class="meta">id <code>${escapeHtml(record.id)}</code> · received
${escapeHtml(record.receivedAt)} · ${record.bodyBytes} bytes</p>
${query}
<h2>Headers</h2>
<table><tbody>${headerRows}</tbody></table>
<h2>Body</h2>${truncated}<pre>${escapeHtml(prettyBody(record))}</pre>`,
  );
}
