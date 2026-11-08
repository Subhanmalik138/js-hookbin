/**
 * CLI — argument parsing and command dispatch for `hookbin`.
 *
 * Hand-rolled parsing on purpose: zero dependencies is a feature of this
 * project, and the surface is small (six commands, a handful of flags).
 * Every command takes `--dir` to point at a different capture store so a
 * team can keep one store per service under test.
 *
 * Commands:
 *   serve   [--port 4000] [--host 127.0.0.1] [--max 500]
 *   list    [--method POST] [--path /git] [--limit 20] [--json]
 *   show <id> [--json]
 *   replay <id> --to <base-url> [--exact <url>]
 *   clear   [--force]
 *   export  [--format json|jsonl] [--out file]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { RequestStore, DEFAULT_MAX_REQUESTS } from "./store.js";
import { createCaptureServer, listen } from "./capture.js";
import { replayRecord } from "./replay.js";

export const VERSION = "1.0.0";
const DEFAULT_DIR = ".hookbin";
const DEFAULT_PORT = 4000;

const HELP = `HookBin ${VERSION} — capture webhooks locally, inspect them, replay them.

Usage:
  hookbin serve   [--port 4000] [--host 127.0.0.1] [--dir .hookbin] [--max 500]
  hookbin list    [--dir .hookbin] [--method POST] [--path /git] [--limit 20] [--json]
  hookbin show <id> [--dir .hookbin] [--json]
  hookbin replay <id> --to <base-url> [--exact <url>] [--dir .hookbin]
  hookbin clear   [--dir .hookbin] [--force]
  hookbin export  [--dir .hookbin] [--format json|jsonl] [--out file]
  hookbin --help | --version

serve starts the capture server. Any request to a path other than /_hookbin/*
is stored; open http://localhost:4000/_hookbin/ to browse captures.
replay --to re-sends a capture to <base-url> + the original path and query;
--exact sends it to one full URL instead.
`;

/** Flags that take a value; every other --flag is boolean. */
const VALUE_FLAGS = new Set([
  "port",
  "host",
  "dir",
  "max",
  "method",
  "path",
  "limit",
  "format",
  "out",
  "to",
  "exact",
]);

/** Parse ["--port","4000","--json"] into { port: "4000", json: true }. */
export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // Only consume the next token as a value for known value-flags:
      // a boolean flag such as --json must never swallow a positional.
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function storeFor(flags) {
  const dir = path.resolve(flags.dir ?? DEFAULT_DIR);
  const max = flags.max ? Number(flags.max) : DEFAULT_MAX_REQUESTS;
  return new RequestStore(dir, max);
}

function fail(message) {
  return { code: 1, stderr: `error: ${message}\n\n${HELP}` };
}

function printRecord(record, asJson) {
  if (asJson) return JSON.stringify(record, null, 2);
  const lines = [
    `${record.method} ${record.path}  ${record.id}`,
    `  received: ${record.receivedAt}  body: ${record.bodyBytes} bytes (${record.bodyEncoding})`,
  ];
  const query = Object.keys(record.query);
  if (query.length) lines.push(`  query: ${JSON.stringify(record.query)}`);
  if (record.body) {
    const preview = record.body.length > 500 ? record.body.slice(0, 500) + "…" : record.body;
    lines.push(`  body: ${preview}`);
  }
  return lines.join("\n");
}

async function cmdServe(flags) {
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  const host = flags.host ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail(`--port must be 1-65535, got "${flags.port}"`);
  }
  const store = storeFor(flags);
  const server = createCaptureServer(store, {
    onCapture: (r) =>
      process.stderr.write(`${r.method} ${r.path} -> ${r.id}\n`),
  });
  const { port: bound } = await listen(server, { host, port });
  process.stdout.write(
    `HookBin listening on http://${host}:${bound}\n` +
      `  captures: ${store.dir}\n` +
      `  inspect:  http://${host}:${bound}/_hookbin/\n` +
      `  API:      http://${host}:${bound}/_hookbin/requests\n` +
      `Press Ctrl+C to stop.\n`,
  );
  await new Promise((resolve) => process.once("SIGINT", resolve));
  server.close();
  return { code: 0 };
}

async function cmdList(flags) {
  const store = storeFor(flags);
  const limit = flags.limit ? Number(flags.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return fail(`--limit must be a positive integer, got "${flags.limit}"`);
  }
  const records = await store.list({
    method: flags.method,
    path: flags.path,
    limit,
  });
  if (records.length === 0) return { code: 0, stdout: "No requests captured yet.\n" };
  const asJson = flags.json === true;
  const out = asJson
    ? JSON.stringify(records, null, 2) + "\n"
    : records.map((r) => printRecord(r, false)).join("\n\n") + "\n";
  return { code: 0, stdout: out };
}

async function cmdShow(id, flags) {
  if (!id) return fail("show needs a request id: hookbin show <id>");
  const record = await storeFor(flags).get(id);
  if (!record) return fail(`no captured request with id "${id}"`);
  const out = flags.json === true ? JSON.stringify(record, null, 2) + "\n" : printRecord(record, false) + "\n";
  return { code: 0, stdout: out };
}

async function cmdReplay(id, flags) {
  if (!id) return fail("replay needs a request id: hookbin replay <id> --to <url>");
  const record = await storeFor(flags).get(id);
  if (!record) return fail(`no captured request with id "${id}"`);
  if (!flags.to && !flags.exact) {
    return fail("replay needs --to <base-url> (or --exact <full-url>)");
  }
  let target;
  if (flags.exact) {
    target = flags.exact;
  } else {
    const base = new URL(flags.to);
    target = `${base.origin}${record.path}${
      Object.keys(record.query).length
        ? "?" + new URLSearchParams(record.query).toString()
        : ""
    }`;
  }
  try {
    const result = await replayRecord(record, target);
    return {
      code: 0,
      stdout: `replayed ${record.method} ${record.path} -> ${target}\nresponse: ${result.status}\n`,
    };
  } catch (err) {
    return { code: 1, stderr: `replay failed: ${err.message}\n` };
  }
}

async function cmdClear(flags) {
  const store = storeFor(flags);
  const count = await store.count();
  if (count === 0) return { code: 0, stdout: "Nothing to clear.\n" };
  if (flags.force !== true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`Delete ${count} captured request(s)? [y/N] `, resolve),
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      return { code: 0, stdout: "Aborted.\n" };
    }
  }
  await store.clear();
  return { code: 0, stdout: `Cleared ${count} captured request(s).\n` };
}

async function cmdExport(flags) {
  const format = flags.format ?? "json";
  if (format !== "json" && format !== "jsonl") {
    return fail(`--format must be json or jsonl, got "${format}"`);
  }
  const records = await storeFor(flags).list();
  const text =
    format === "jsonl"
      ? records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")
      : JSON.stringify(records, null, 2) + "\n";
  if (flags.out) {
    await fs.writeFile(path.resolve(flags.out), text, "utf8");
    return { code: 0, stdout: `Exported ${records.length} request(s) to ${flags.out}\n` };
  }
  return { code: 0, stdout: text };
}

/** Run the CLI. Returns a process exit code; never throws for user errors. */
export async function run(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  if (command === undefined || command === "--help" || command === "-h") {
    return { code: 0, stdout: HELP };
  }
  if (command === "--version" || command === "-v") {
    return { code: 0, stdout: `hookbin ${VERSION}\n` };
  }

  try {
    switch (command) {
      case "serve":
        return await cmdServe(flags);
      case "list":
        return await cmdList(flags);
      case "show":
        return await cmdShow(positional[0], flags);
      case "replay":
        return await cmdReplay(positional[0], flags);
      case "clear":
        return await cmdClear(flags);
      case "export":
        return await cmdExport(flags);
      default:
        return fail(`unknown command "${command}"`);
    }
  } catch (err) {
    return { code: 1, stderr: `error: ${err.message}\n` };
  }
}
