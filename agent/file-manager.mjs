import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_READ_RESPONSE_BYTES = 32 * 1024;
const DEFAULT_MULTI_READ_RESPONSE_BYTES = 48 * 1024;
const MAX_READ_RESPONSE_BYTES = 48 * 1024;
const MIN_READ_RESPONSE_BYTES = 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 5000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_RESPONSE_BYTES = 48 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", ".idea", ".wrangler"]);
const ALLOWED_DOT_DIRS = new Set([".github"]);

function skipWalkDirectory(name) {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && !ALLOWED_DOT_DIRS.has(name));
}

function splitRoots(spec) {
  if (!spec) return [process.cwd()];
  return spec.split(";").map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingCanonical(target) {
  return fs.realpath(target);
}

function byteSize(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedReadBytes(value, fallback, minimum = MIN_READ_RESPONSE_BYTES) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.floor(numeric), minimum), MAX_READ_RESPONSE_BYTES);
}

function normalizeReadRequest(input) {
  return typeof input === "string" ? { path: input } : { ...(input || {}) };
}

export class FileManager {
  constructor(rootSpec) {
    this.roots = splitRoots(rootSpec);
    this.searches = new Map();
  }

  getRoots() {
    return [...this.roots];
  }

  async #resolveExisting(input) {
    const target = path.resolve(String(input));
    const canonical = await existingCanonical(target);
    for (const root of this.roots) {
      const canonicalRoot = await existingCanonical(root).catch(() => path.resolve(root));
      if (within(canonicalRoot, canonical)) return canonical;
    }
    throw new Error("path_not_allowed");
  }

  async #resolveTarget(input) {
    const target = path.resolve(String(input));
    const parent = await existingCanonical(path.dirname(target));
    for (const root of this.roots) {
      const canonicalRoot = await existingCanonical(root).catch(() => path.resolve(root));
      if (within(canonicalRoot, parent)) return target;
    }
    throw new Error("path_not_allowed");
  }

  async stat(input) {
    const target = await this.#resolveExisting(input);
    const info = await fs.stat(target);
    return {
      path: target,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      createdAt: info.birthtime.toISOString(),
    };
  }

  async list(input, depth = 1, offset = 0, limit = DEFAULT_LIST_LIMIT, maxBytes = DEFAULT_LIST_RESPONSE_BYTES) {
    const target = await this.#resolveExisting(input);
    const numericDepth = Number(depth);
    const maxDepth = Number.isFinite(numericDepth) ? Math.min(Math.max(Math.trunc(numericDepth), 0), 3) : 1;
    const start = Math.max(Math.trunc(Number(offset) || 0), 0);
    const pageLimit = Math.min(Math.max(Math.trunc(Number(limit) || DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    const responseBudget = boundedReadBytes(maxBytes, DEFAULT_LIST_RESPONSE_BYTES, 4 * 1024);
    const entries = [];
    await this.#walkList(target, 0, maxDepth, entries, start + pageLimit + 1);

    const selected = entries.slice(start, start + pageLimit);
    while (selected.length > 1 && byteSize({ path: target, entries: selected, offset: start }) > responseBudget) selected.pop();
    if (selected.length === 1 && byteSize({ path: target, entries: selected, offset: start }) > responseBudget) throw new Error("list_entry_too_large");

    const nextOffset = start + selected.length;
    const hasMore = nextOffset < entries.length;
    return { path: target, entries: selected, offset: start, limit: pageLimit, maxBytes: responseBudget, truncated: hasMore, nextOffset: hasMore ? nextOffset : null };
  }

  async #walkList(current, level, maxDepth, output, stopAfter = 1001) {
    const items = await fs.readdir(current, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      let size = null;
      if (item.isFile()) size = (await fs.stat(fullPath)).size;
      output.push({ path: fullPath, name: item.name, type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other", size });
      if (output.length >= stopAfter) return;
      if (item.isDirectory() && level < maxDepth && !skipWalkDirectory(item.name)) {
        await this.#walkList(fullPath, level + 1, maxDepth, output, stopAfter);
        if (output.length >= stopAfter) return;
      }
    }
  }

  async read(input, offset = 0, length = 200, maxBytes = DEFAULT_READ_RESPONSE_BYTES) {
    const target = await this.#resolveExisting(input);
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error("not_a_file");
    if (info.size > MAX_READ_BYTES * 8) throw new Error("file_too_large");

    const text = await fs.readFile(target, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(Number(offset) || 0, 0);
    const count = Math.min(Math.max(Number(length) || 200, 1), 1000);
    const contentBudget = boundedReadBytes(maxBytes, DEFAULT_READ_RESPONSE_BYTES);
    const end = Math.min(start + count, lines.length);
    const selected = [];
    let contentBytes = 0;

    for (let index = start; index < end; index++) {
      const line = lines[index];
      const nextBytes = byteSize(line) + (selected.length === 0 ? 0 : 1);
      if (contentBytes + nextBytes > contentBudget) {
        if (selected.length === 0) throw new Error("line_too_large");
        break;
      }
      selected.push(line);
      contentBytes += nextBytes;
    }

    const nextOffset = start + selected.length;
    const truncated = nextOffset < lines.length;
    return {
      path: target,
      offset: start,
      length: selected.length,
      totalLines: lines.length,
      content: selected.join("\n"),
      contentBytes,
      truncated,
      nextOffset: truncated ? nextOffset : null,
    };
  }

  async readMany(paths, maxTotalBytes = DEFAULT_MULTI_READ_RESPONSE_BYTES) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new Error("invalid_paths");
    }

    const requests = paths.map(normalizeReadRequest);
    if (requests.some((entry) => typeof entry.path !== "string" || entry.path.length === 0)) {
      throw new Error("invalid_paths");
    }

    const totalBudget = boundedReadBytes(
      maxTotalBytes,
      DEFAULT_MULTI_READ_RESPONSE_BYTES,
      4 * 1024,
    );
    const files = [];
    let nextIndex = null;

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const start = Math.max(Number(request.offset) || 0, 0);
      const length = Math.min(Math.max(Number(request.length) || 1000, 1), 1000);
      let fileBudget = boundedReadBytes(request.maxBytes, DEFAULT_READ_RESPONSE_BYTES);
      let candidate;

      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const result = await this.read(request.path, start, length, fileBudget);
          candidate = { ok: true, ...result };
          const projected = {
            files: [...files, candidate],
            totalFiles: requests.length,
            nextIndex: index + 1 < requests.length ? index + 1 : null,
            truncated: false,
            maxTotalBytes: totalBudget,
          };
          if (byteSize(projected) <= totalBudget) break;
          fileBudget = Math.floor(fileBudget * 0.65);
          candidate = undefined;
          if (fileBudget < MIN_READ_RESPONSE_BYTES) break;
        }
      } catch (error) {
        candidate = {
          ok: false,
          path: String(request.path),
          error: error instanceof Error ? error.message : "read_failed",
        };
      }

      if (!candidate) {
        nextIndex = index;
        break;
      }

      const projected = {
        files: [...files, candidate],
        totalFiles: requests.length,
        nextIndex: index + 1 < requests.length ? index + 1 : null,
        truncated: false,
        maxTotalBytes: totalBudget,
      };
      if (byteSize(projected) > totalBudget) {
        nextIndex = index;
        break;
      }
      files.push(candidate);
    }

    const fileTruncated = files.some((entry) => entry.ok && entry.truncated);
    const truncated = nextIndex !== null || fileTruncated;
    return {
      files,
      totalFiles: requests.length,
      nextIndex,
      truncated,
      maxTotalBytes: totalBudget,
    };
  }

  async write(input, content, mode = "rewrite") {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error("content_too_large");
    }
    const target = await this.#resolveTarget(input);
    if (mode === "append") await fs.appendFile(target, content, "utf8");
    else if (mode === "rewrite") await fs.writeFile(target, content, "utf8");
    else throw new Error("invalid_write_mode");
    return this.stat(target);
  }

  async edit(input, oldText, newText, expectedReplacements = 1) {
    if (typeof oldText !== "string" || oldText.length === 0 || typeof newText !== "string") {
      throw new Error("invalid_edit");
    }
    const target = await this.#resolveExisting(input);
    const text = await fs.readFile(target, "utf8");
    const parts = text.split(oldText);
    const matches = parts.length - 1;
    const expected = Number(expectedReplacements) || 1;
    if (matches !== expected) {
      throw new Error(`replacement_count_mismatch:${matches}`);
    }
    const updated = parts.join(newText);
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES * 8) throw new Error("file_too_large");
    await fs.writeFile(target, updated, "utf8");
    return { path: target, replacements: matches };
  }

  async mkdir(input) {
    const target = await this.#resolveTarget(input);
    await fs.mkdir(target, { recursive: true });
    return this.stat(target);
  }

  async move(source, destination) {
    const from = await this.#resolveExisting(source);
    const to = await this.#resolveTarget(destination);
    await fs.rename(from, to);
    return { from, to };
  }

  async remove(input, recursive = false) {
    const target = await this.#resolveExisting(input);
    if (this.roots.some((root) => path.resolve(root) === path.resolve(target))) {
      throw new Error("cannot_delete_root");
    }
    const info = await fs.stat(target);
    if (info.isDirectory()) await fs.rm(target, { recursive: Boolean(recursive), force: false });
    else await fs.unlink(target);
    return { ok: true, path: target };
  }

  async startSearch(input, pattern, searchType = "files", maxResults = 100) {
    const target = await this.#resolveExisting(input);
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 300) {
      throw new Error("invalid_pattern");
    }
    if (!["files", "content"].includes(searchType)) throw new Error("invalid_search_type");

    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      status: "RUNNING",
      createdAt: Date.now(),
      results: [],
      error: null,
    };
    this.searches.set(sessionId, session);

    try {
      const limit = Math.min(Math.max(Number(maxResults) || 100, 1), 500);
      const needle = pattern.toLowerCase();
      let scanned = 0;

      const queue = [target];
      while (queue.length > 0 && session.results.length < limit && scanned < MAX_SEARCH_FILES) {
        const current = queue.shift();
        const items = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
          if (session.results.length >= limit || scanned >= MAX_SEARCH_FILES) break;
          if (item.isDirectory() && skipWalkDirectory(item.name)) continue;
          const fullPath = path.join(current, item.name);
          scanned++;

          if (searchType === "files" && item.name.toLowerCase().includes(needle)) {
            session.results.push({ path: fullPath, name: item.name, type: item.isDirectory() ? "directory" : "file" });
          } else if (searchType === "content" && item.isFile()) {
            const info = await fs.stat(fullPath).catch(() => null);
            if (info && info.size <= 1024 * 1024) {
              const text = await fs.readFile(fullPath, "utf8").catch(() => null);
              if (text != null) {
                const index = text.toLowerCase().indexOf(needle);
                if (index >= 0) {
                  const before = text.slice(0, index);
                  const line = before.split(/\r?\n/).length;
                  session.results.push({ path: fullPath, line, preview: text.slice(index, index + 240) });
                }
              }
            }
          }
          if (item.isDirectory()) queue.push(fullPath);
        }
      }
      session.status = "COMPLETED";
      session.scanned = scanned;
    } catch (error) {
      session.status = "ERROR";
      session.error = error instanceof Error ? error.message : "search_failed";
    }

    return {
      sessionId,
      status: session.status,
      totalResults: session.results.length,
      scanned: session.scanned ?? 0,
      error: session.error,
    };
  }

  getSearchResults(sessionId, offset = 0, length = 50) {
    const session = this.searches.get(String(sessionId));
    if (!session) throw new Error("search_not_found");
    const start = Math.max(Number(offset) || 0, 0);
    const count = Math.min(Math.max(Number(length) || 50, 1), 100);
    return {
      sessionId: session.id,
      status: session.status,
      totalResults: session.results.length,
      offset: start,
      results: session.results.slice(start, start + count),
      error: session.error,
    };
  }
}
