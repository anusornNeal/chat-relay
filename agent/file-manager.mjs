import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", ".idea", ".wrangler"]);

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

  async list(input, depth = 1) {
    const target = await this.#resolveExisting(input);
    const maxDepth = Math.min(Math.max(Number(depth) || 1, 0), 3);
    const entries = [];
    await this.#walkList(target, 0, maxDepth, entries);
    return { path: target, entries };
  }

  async #walkList(current, level, maxDepth, output) {
    const items = await fs.readdir(current, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      let size = null;
      if (item.isFile()) size = (await fs.stat(fullPath)).size;
      output.push({
        path: fullPath,
        name: item.name,
        type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other",
        size,
      });
      if (output.length >= 1000) return;
      if (item.isDirectory() && level < maxDepth && !SKIP_DIRS.has(item.name)) {
        await this.#walkList(fullPath, level + 1, maxDepth, output);
        if (output.length >= 1000) return;
      }
    }
  }

  async read(input, offset = 0, length = 200) {
    const target = await this.#resolveExisting(input);
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error("not_a_file");
    if (info.size > MAX_READ_BYTES * 8) throw new Error("file_too_large");

    const text = await fs.readFile(target, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(Number(offset) || 0, 0);
    const count = Math.min(Math.max(Number(length) || 200, 1), 1000);
    return {
      path: target,
      offset: start,
      length: Math.min(count, Math.max(lines.length - start, 0)),
      totalLines: lines.length,
      content: lines.slice(start, start + count).join("\n"),
    };
  }

  async readMany(paths) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new Error("invalid_paths");
    }
    const files = [];
    for (const input of paths) {
      try {
        files.push({ ok: true, ...(await this.read(input, 0, 1000)) });
      } catch (error) {
        files.push({ ok: false, path: String(input), error: error instanceof Error ? error.message : "read_failed" });
      }
    }
    return { files };
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

      const walk = async (current) => {
        if (session.results.length >= limit || scanned >= MAX_SEARCH_FILES) return;
        const items = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const item of items) {
          if (session.results.length >= limit || scanned >= MAX_SEARCH_FILES) break;
          if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
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

          if (item.isDirectory()) await walk(fullPath);
        }
      };

      await walk(target);
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
