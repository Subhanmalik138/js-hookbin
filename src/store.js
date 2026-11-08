/**
 * RequestStore — persistence for captured requests.
 *
 * Storage format: one JSON object per line in `requests.jsonl` inside the
 * data directory (default `.hookbin/`). JSONL was chosen deliberately:
 *
 *   - appending a capture is a single O(1) write, no read-modify-write;
 *   - a corrupt line can be skipped without losing the whole log;
 *   - the file is human-readable and greppable with standard tools.
 *
 * The store keeps an in-memory array (newest first is NOT assumed — the
 * array is in arrival order and `list()` reverses for display) and caps
 * itself at `maxRequests`: when the cap is exceeded the oldest records are
 * dropped and the file is rewritten atomically (write temp + rename).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidRecord } from "./request.js";

export const DEFAULT_MAX_REQUESTS = 500;

export class RequestStore {
  /**
   * @param {string} dir        data directory (created on first write)
   * @param {number} maxRequests maximum records kept; older ones are evicted
   */
  constructor(dir, maxRequests = DEFAULT_MAX_REQUESTS) {
    this.dir = dir;
    this.file = path.join(dir, "requests.jsonl");
    this.maxRequests = maxRequests;
    this.records = [];
    this.loaded = false;
  }

  /** Load records from disk. Safe to call repeatedly; reloads from scratch. */
  async load() {
    this.records = [];
    try {
      const text = await fs.readFile(this.file, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (isValidRecord(parsed)) this.records.push(parsed);
          // Invalid lines are skipped, not fatal: one bad line must never
          // take down the whole capture log.
        } catch {
          continue;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // missing file = empty store
    }
    this.loaded = true;
    return this.records;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
  }

  /** Append a record, evicting the oldest ones past the cap. */
  async add(record) {
    await this.ensureLoaded();
    await fs.mkdir(this.dir, { recursive: true });
    this.records.push(record);
    await fs.appendFile(this.file, JSON.stringify(record) + "\n", "utf8");
    if (this.records.length > this.maxRequests) {
      this.records = this.records.slice(-this.maxRequests);
      await this.rewrite();
    }
    return record;
  }

  /** Rewrite the whole log atomically (temp file + rename). */
  async rewrite() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    const text = this.records.map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(tmp, text.length ? text + "\n" : "", "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Newest-first list, optionally filtered. Filters are ANDed. */
  async list({ method, path, limit } = {}) {
    await this.ensureLoaded();
    let out = [...this.records].reverse();
    if (method) out = out.filter((r) => r.method === method.toUpperCase());
    if (path) out = out.filter((r) => r.path.includes(path));
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  /** Find one record by id, or null. */
  async get(id) {
    await this.ensureLoaded();
    return this.records.find((r) => r.id === id) ?? null;
  }

  /** Delete everything. Returns the number of records removed. */
  async clear() {
    await this.ensureLoaded();
    const count = this.records.length;
    this.records = [];
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, "", "utf8");
    return count;
  }

  async count() {
    await this.ensureLoaded();
    return this.records.length;
  }
}
