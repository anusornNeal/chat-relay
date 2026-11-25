import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deduplicateSearchPreviews } from "./fs-batch-preview.mjs";

const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_READ_RESPONSE_BYTES = 32 * 1024;
const DEFAULT_MULTI_READ_RESPONSE_BYTES = 48 * 1024;
const DEFAULT_BATCH_RESPONSE_BYTES = 48 * 1024;
const MAX_BATCH_OPERATIONS = 20;
const MAX_BATCH_SEARCHES = 8;
const MAX_BATCH_EDIT_BYTES = 48 * 1024;
const MAX_BATCH_EDITS = 100;
const MAX_ARTIFACT_BYTES = 40 * 1024;
const ARTIFACT_MIME_TYPES = new Map([
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

const MAX_READ_RESPONSE_BYTES = 48 * 1024;
const MIN_READ_RESPONSE_BYTES = 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FIRST_PAGE_RESULTS = 20;
const MAX_SEARCH_FIRST_PAGE_BYTES = 16 * 1024;
const MAX_SEARCH_SESSIONS = 64;
const SEARCH_SESSION_TTL_MS = 15 * 60 * 1000;
const GENERATED_SEARCH_DIRS = new Set(["build", "dist", "coverage", "out", "__pycache__"]);
const SEARCH_BINARY_EXTENSIONS = new Set([
  ".apk", ".aab", ".class", ".dex", ".jar", ".so", ".dll", ".exe", ".bin",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".mp3", ".mp4", ".woff", ".woff2", ".ttf", ".otf", ".db", ".sqlite",
]);
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_RESPONSE_BYTES = 48 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", ".idea", ".wrangler"]);
const ALLOWED_DOT_DIRS = new Set([".github"]);

function skipWalkDirectory(name) {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && !ALLOWED_DOT_DIRS.has(name));
}

function skipSearchDirectory(name) {
  return skipWalkDirectory(name) || GENERATED_SEARCH_DIRS.has(name.toLowerCase());
}

const SEARCH_CONTENT_CONCURRENCY = 8;

async function matchSearchContent(fullPath, needle) {
  const info = await fs.stat(fullPath).catch(() => null);
  if (!info || info.size > 1024 * 1024) return null;
  const bytes = await fs.readFile(fullPath).catch(() => null);
  if (!bytes || bytes.subarray(0, 1024).includes(0)) return null;
  const content = bytes.toString("utf8");
  const index = content.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  return {
    path: fullPath,
    line: content.slice(0, index).split(/\r?\n/).length,
    preview: content.slice(index, index + 240),
  };
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

function utf8Bytes(text, max) {
  if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")) throw new Error("invalid_utf8");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > max) throw new Error("file_too_large");
  return bytes;
}

function editError(error) {
  // Return a compact stable error, not paths or an arbitrary OS exception string.
  const code = typeof error?.code === "string" ? error.code : error?.message;
  return typeof code === "string" && /^[a-zA-Z0-9_:-]{1,100}$/.test(code) ? code : "batch_edit_failed";
}

export class FileManager {
  constructor(rootSpec) {
    this.roots = splitRoots(rootSpec);
    this.searches = new Map();
    this.editBatchTail = Promise.resolve();
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

  async #resolveBatchBase(basePath) {
    if (basePath === undefined || basePath === null) return null;
    if (typeof basePath !== "string" || !path.isAbsolute(basePath)) throw new Error("invalid_base_path");
    const base = await this.#resolveExisting(basePath);
    if (!(await fs.stat(base)).isDirectory()) throw new Error("base_not_directory");
    return base;
  }

  async #batchPath(input, base, create = false) {
    if (typeof input !== "string" || !input || input.includes("\0")) throw new Error("invalid_path");
    if (process.platform === "win32" && input.replace(/^[a-z]:/i, "").includes(":")) {
      throw new Error("invalid_path");
    }
    if (!base && !create) return input;
    if (base && (path.isAbsolute(input) || path.win32.isAbsolute(input) || /^[a-z]:/i.test(input))) {
      throw new Error("relative_path_required");
    }
    const target = path.resolve(base || process.cwd(), input);
    if (base && !within(base, target)) throw new Error("path_outside_base");
    if (create) {
      const parent = await this.#resolveExisting(path.dirname(target));
      if (base && !within(base, parent)) throw new Error("path_outside_base");
      return path.join(parent, path.basename(target));
    }
    const canonical = await this.#resolveExisting(target);
    if (base && !within(base, canonical)) throw new Error("path_outside_base");
    return canonical;
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
    const payloadFor = (items) => {
      const nextOffset = start + items.length;
      const hasMore = nextOffset < entries.length;
      return {
        path: target,
        entries: items,
        offset: start,
        limit: pageLimit,
        maxBytes: responseBudget,
        truncated: hasMore,
        nextOffset: hasMore ? nextOffset : null,
      };
    };
    while (selected.length > 1 && byteSize(payloadFor(selected)) > responseBudget) selected.pop();
    if (selected.length === 1 && byteSize(payloadFor(selected)) > responseBudget) throw new Error("list_entry_too_large");

    return payloadFor(selected);
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

  async readMany(paths, maxTotalBytes = DEFAULT_MULTI_READ_RESPONSE_BYTES, basePath) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new Error("invalid_paths");
    }

    const base = basePath == null ? null : await this.#resolveBatchBase(basePath);
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
        const target = base ? await this.#batchPath(request.path, base) : request.path;
        for (let attempt = 0; attempt < 8; attempt++) {
          const result = await this.read(target, start, length, fileBudget);
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


  async batch(operations, maxTotalBytes = DEFAULT_BATCH_RESPONSE_BYTES, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_BATCH_OPERATIONS) {
      throw new Error("invalid_batch");
    }
    if (operations.filter((item) => item?.op === "search").length > MAX_BATCH_SEARCHES) {
      throw new Error("too_many_batch_searches");
    }
    const batchBase = options.basePath == null ? null : await this.#resolveBatchBase(options.basePath);
    const totalBudget = boundedReadBytes(maxTotalBytes, DEFAULT_BATCH_RESPONSE_BYTES, 4 * 1024);
    const results = [];
    let nextIndex = null;
    const payloadFor = (rows, next, truncated = false) => ({
      ...(options.deduplicatePreviews === true ? deduplicateSearchPreviews(rows) : { results: rows }),
      totalOperations: operations.length,
      nextIndex: next,
      truncated,
      maxTotalBytes: totalBudget,
    });

    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index] || {};
      const op = String(operation.op || "");
      const base = {
        index,
        ...(typeof operation.id === "string" && operation.id ? { id: operation.id.slice(0, 128) } : {}),
        op,
        ...(typeof operation.path === "string" ? { path: operation.path } : {}),
      };
      const next = index + 1 < operations.length ? index + 1 : null;
      const fits = candidate => byteSize(payloadFor([...results, candidate], next)) <= totalBudget;
      const minimumBudget = op === "list" ? 4 * 1024 : MIN_READ_RESPONSE_BYTES;
      const fallbackBudget = op === "list" ? DEFAULT_LIST_RESPONSE_BYTES : DEFAULT_READ_RESPONSE_BYTES;
      let operationBudget = boundedReadBytes(operation.maxBytes, fallbackBudget, minimumBudget);
      let candidate;
      try {
        if (typeof operation.path !== "string" || !operation.path) throw new Error("invalid_path");
        const target = batchBase ? await this.#batchPath(operation.path, batchBase) : operation.path;
        for (let attempt = 0; attempt < 8; attempt++) {
          let result;
          if (op === "stat") result = await this.stat(target);
          else if (op === "read") result = await this.read(target, operation.offset, operation.length, operationBudget);
          else if (op === "list") result = await this.list(target, operation.depth, operation.offset, operation.limit, operationBudget);
          else if (op === "search") result = await this.startSearch(target, operation.pattern, operation.searchType, operation.maxResults ?? 10, operation.previewLines);
          else throw new Error("invalid_batch_operation");

          candidate = { ...base, ok: true, result };
          if (fits(candidate)) break;
          candidate = undefined;
          if (op === "search") {
            // Do not repeat a scan just to fit its initial response page.
            for (let keep = result.results.length - 1; keep >= 0; keep--) {
              const page = { ...result, results: result.results.slice(0, keep),
                nextOffset: keep < result.totalResults ? keep : null };
              const reduced = { ...base, ok: true, result: page };
              if (fits(reduced)) { candidate = reduced; break; }
            }
            break;
          }
          if (op === "stat") break;
          operationBudget = Math.floor(operationBudget * 0.65);
          if (operationBudget < minimumBudget) break;
        }
      } catch (error) {
        candidate = { ...base, ok: false, error: error instanceof Error ? error.message : "batch_operation_failed" };
      }
      if (!candidate || !fits(candidate)) { nextIndex = index; break; }
      results.push(candidate);
    }

    const nestedTruncated = results.some(entry => entry.ok && (
      entry.result?.truncated === true || (entry.op === "search" && entry.result?.nextOffset !== null)
    ));
    return payloadFor(results, nextIndex, nextIndex !== null || nestedTruncated);
  }

  // One entry per file, multiple exact replacements per entry. Separate from read-only batch.
  editMany(operations, basePath) {
    const run = this.editBatchTail.then(() => this.#editMany(operations, basePath));
    this.editBatchTail = run.catch(() => {});
    return run;
  }

  async #editMany(operations, basePath) {
    if (!Array.isArray(operations) || !operations.length || operations.length > MAX_BATCH_OPERATIONS) {
      throw new Error("invalid_edit_batch");
    }
    if (byteSize({ operations, basePath }) > MAX_BATCH_EDIT_BYTES) throw new Error("edit_batch_too_large");
    const count = operations.reduce((sum, op) => sum + (Array.isArray(op?.edits) ? op.edits.length : 0), 0);
    if (count > MAX_BATCH_EDITS) throw new Error("too_many_batch_edits");
    const base = await this.#resolveBatchBase(basePath);
    const resolved = [];
    const targets = new Map();
    for (const [index, operation] of operations.entries()) {
      const input = typeof operation?.path === "string" ? operation.path : "";
      const row = { index, path: input.slice(0, 512), ...(input.length > 512 ? { pathTruncated: true } : {}) };
      try {
        if (!["create", "edit"].includes(operation?.op)) throw new Error("invalid_edit_batch_operation");
        const create = operation.op === "create";
        const selected = await this.#batchPath(input, base, create);
        const target = create ? selected : await this.#resolveExisting(selected);
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        resolved.push({ row, operation, target, key });
        targets.set(key, (targets.get(key) || 0) + 1);
      } catch (error) {
        resolved.push({ row: { ...row, ok: false, error: editError(error) } });
      }
    }

    const results = [];
    for (const entry of resolved) {
      if (!entry.target) { results.push(entry.row); continue; }
      const { row, operation, target, key } = entry;
      try {
        if (targets.get(key) > 1) throw new Error("duplicate_batch_target");
        const create = operation.op === "create";
        let original = null, mode, updated, replacements = 0;
        if (create) {
          updated = utf8Bytes(operation.content, MAX_WRITE_BYTES);
        } else {
          const info = await fs.lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("not_a_file");
          if (info.size > MAX_WRITE_BYTES * 8) throw new Error("file_too_large");
          original = await fs.readFile(target);
          if (original.length > MAX_WRITE_BYTES * 8) throw new Error("file_too_large");
          if (original.includes(0)) throw new Error("invalid_utf8");
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original); }
          catch { throw new Error("invalid_utf8"); }
          mode = info.mode & 0o777;
          if (!Array.isArray(operation.edits) || !operation.edits.length || operation.edits.length > 20) throw new Error("invalid_edit");
          const crlf = text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n");
          const eol = value => crlf ? value.replace(/\r?\n/g, "\r\n") : value;
          for (const edit of operation.edits) {
            if (typeof edit?.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string" ||
                !edit.oldText.isWellFormed() || !edit.newText.isWellFormed()) throw new Error("invalid_edit");
            const expected = edit.expectedReplacements ?? 1;
            if (!Number.isInteger(expected) || expected < 1 || expected > 100) throw new Error("invalid_edit");
            const parts = text.split(eol(edit.oldText));
            const matches = parts.length - 1;
            if (matches !== expected) throw new Error("replacement_count_mismatch:" + matches);
            text = parts.join(eol(edit.newText));
            replacements += matches;
          }
          updated = utf8Bytes(text, MAX_WRITE_BYTES * 8);
        }
        await this.#commitBatchFile(target, original, updated, mode, base);
        results.push({ ...row, ok: true, op: operation.op, bytes: updated.length, ...(create ? {} : { replacements }) });
      } catch (error) {
        results.push({ ...row, ok: false, op: operation.op, error: editError(error) });
      }
    }
    const succeeded = results.filter(row => row.ok).length;
    return { ok: succeeded === results.length, requested: results.length, succeeded, failed: results.length - succeeded,
      ...(succeeded === results.length ? {} : { error: "batch_edit_partial_failure" }), results };
  }

  async #commitBatchFile(target, original, updated, mode, base) {
    const parent = await this.#resolveExisting(path.dirname(target));
    if (base && !within(base, parent)) throw new Error("path_outside_base");
    if (path.relative(parent, path.dirname(target)) !== "") throw new Error("target_changed");
    const temporary = path.join(parent, ".chat-relay-" + randomUUID() + ".tmp");
    try {
      await fs.writeFile(temporary, updated, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
      const currentParent = await this.#resolveExisting(parent);
      if (path.relative(parent, currentParent) !== "") throw new Error("target_changed");
      if (original === null) {
        // Same-directory link is an atomic no-clobber publish, even if another creator wins.
        await fs.link(temporary, target);
      } else {
        const info = await fs.lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== original.length ||
            !(await fs.readFile(target)).equals(original)) throw new Error("target_changed");
        // Atomic replacement per file, not a transaction across files or an OS-level CAS.
        await fs.rename(temporary, target);
      }
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async exportArtifact(input, maxBytes = MAX_ARTIFACT_BYTES) {
    const target = await this.#resolveExisting(input);
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error("not_a_file");

    const requested = Number(maxBytes);
    const byteLimit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1024), MAX_ARTIFACT_BYTES)
      : MAX_ARTIFACT_BYTES;
    if (info.size <= 0) throw new Error("artifact_empty");
    if (info.size > byteLimit) throw new Error("artifact_too_large");

    const bytes = await fs.readFile(target);
    const extension = path.extname(target).toLowerCase();
    const mimeType = ARTIFACT_MIME_TYPES.get(extension) || "application/octet-stream";
    return {
      ok: true,
      filename: path.basename(target).slice(0, 180),
      mimeType,
      byteLength: bytes.byteLength,
      data: bytes.toString("base64"),
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

  #pruneSearchSessions(reserve = 0) {
    const now = Date.now();
    for (const [id, session] of this.searches) {
      if (session.expiresAt <= now) this.searches.delete(id);
    }
    while (this.searches.size > MAX_SEARCH_SESSIONS - reserve) {
      this.searches.delete(this.searches.keys().next().value);
    }
  }

  async startSearch(input, pattern, searchType = "files", maxResults = 100, previewLines = 0) {
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
      scanned: 0,
      incomplete: false,
      stopReason: null,
      error: null,
    };

    try {
      const limit = Math.min(Math.max(Number(maxResults) || 100, 1), 500);
      const needle = pattern.toLowerCase();
      const queue = [target];

      while (queue.length > 0 && session.results.length < limit && session.scanned < MAX_SEARCH_FILES) {
        const current = queue.shift();
        const items = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        items.sort((a, b) => a.name.localeCompare(b.name));
        // Prefetch up to eight independent file reads without changing BFS result order.
        // Speculative reads may exceed the logical result cap by at most one small window.
        const windowSize = searchType === "content" ? SEARCH_CONTENT_CONCURRENCY : Math.max(items.length, 1);
        for (let offset = 0; offset < items.length; offset += windowSize) {
          const group = items.slice(offset, offset + windowSize);
          const contentMatches = searchType === "content"
            ? await Promise.all(group.map((item) =>
              item.isFile() && !SEARCH_BINARY_EXTENSIONS.has(path.extname(item.name).toLowerCase())
                ? matchSearchContent(path.join(current, item.name), needle)
                : null))
            : null;

          for (let index = 0; index < group.length; index++) {
            if (session.results.length >= limit || session.scanned >= MAX_SEARCH_FILES) {
              session.incomplete = true;
              session.stopReason = session.results.length >= limit ? "result_limit" : "scan_limit";
              break;
            }
            const item = group[index];
            if (item.isDirectory() && skipSearchDirectory(item.name)) continue;
            const fullPath = path.join(current, item.name);
            session.scanned++;

            if (searchType === "files" && item.name.toLowerCase().includes(needle)) {
              session.results.push({ path: fullPath, name: item.name, type: item.isDirectory() ? "directory" : "file" });
            } else if (contentMatches?.[index]) {
              session.results.push(contentMatches[index]);
            }
            if (item.isDirectory()) queue.push(fullPath);
          }
          if (session.incomplete) break;
        }
        if (!session.incomplete && queue.length > 0
          && (session.results.length >= limit || session.scanned >= MAX_SEARCH_FILES)) {
          session.incomplete = true;
          session.stopReason = session.results.length >= limit ? "result_limit" : "scan_limit";
        }
      }
      session.status = "COMPLETED";
    } catch (error) {
      session.status = "ERROR";
      session.incomplete = true;
      session.stopReason = "error";
      session.error = error instanceof Error ? error.message : "search_failed";
    }

    // The search is synchronous from the caller's perspective. Retain only finished sessions.
    this.#pruneSearchSessions(1);
    session.expiresAt = Date.now() + SEARCH_SESSION_TTL_MS;
    this.searches.set(sessionId, session);

    // Most callers only need the first few matches; avoid a second MCP round trip.
    const firstPage = [];
    let pageBytes = 0;
    for (const item of session.results.slice(0, MAX_SEARCH_FIRST_PAGE_RESULTS)) {
      const size = byteSize(item);
      if (firstPage.length > 0 && pageBytes + size > MAX_SEARCH_FIRST_PAGE_BYTES) break;
      firstPage.push({ ...item });
      pageBytes += size;
    }
    await this.#addSearchPreviews(firstPage, previewLines);
    return {
      sessionId,
      status: session.status,
      totalResults: session.results.length,
      scanned: session.scanned,
      incomplete: session.incomplete,
      stopReason: session.stopReason,
      error: session.error,
      offset: 0,
      results: firstPage,
      nextOffset: firstPage.length < session.results.length ? firstPage.length : null,
    };
  }

  // A page of matches can be expanded without repeating the original search.
  async getSearchResultsWithPreview(sessionId, offset = 0, length = 50, previewLines = 0) {
    const requested = Number(previewLines) > 0 ? Math.min(Math.max(Number(length) || 50, 1), 20) : length;
    const page = this.getSearchResults(sessionId, offset, requested);
    page.results = page.results.map((item) => ({ ...item }));
    await this.#addSearchPreviews(page.results, previewLines);
    return page;
  }

  async #addSearchPreviews(results, requestedLines) {
    const count = Math.min(60, Math.max(0, Math.trunc(Number(requestedLines) || 0)));
    if (count === 0) return;
    let remaining = 16 * 1024;
    for (const item of results) {
      if (remaining < 1024) break;
      if (!item.path || item.type === "directory") continue;
      const matchSnippet = typeof item.preview === "string" ? item.preview : undefined;
      const start = Number.isInteger(item.line)
        ? Math.max(0, item.line - 1 - Math.floor(count / 2)) : 0;
      try {
        const read = await this.read(item.path, start, count, Math.min(4096, remaining));
        const context = { offset: read.offset, length: read.length, totalLines: read.totalLines,
          content: read.content, truncated: read.truncated, nextOffset: read.nextOffset };
        if (matchSnippet && read.offset + read.length < item.line) context.matchSnippet = matchSnippet;
        if (byteSize(context) > remaining) break;
        item.preview = context;
        remaining -= byteSize(context);
      } catch {
        item.preview = { unavailable: true, ...(matchSnippet ? { matchSnippet } : {}) };
      }
    }
  }

  getSearchResults(sessionId, offset = 0, length = 50) {
    this.#pruneSearchSessions();
    const key = String(sessionId);
    const session = this.searches.get(key);
    if (!session) throw new Error("search_not_found");
    session.expiresAt = Date.now() + SEARCH_SESSION_TTL_MS;
    this.searches.delete(key);
    this.searches.set(key, session);

    const start = Math.max(Number(offset) || 0, 0);
    const count = Math.min(Math.max(Number(length) || 50, 1), 100);
    const results = session.results.slice(start, start + count);
    const nextOffset = start + results.length;
    return {
      sessionId: session.id,
      status: session.status,
      totalResults: session.results.length,
      scanned: session.scanned,
      incomplete: session.incomplete,
      stopReason: session.stopReason,
      offset: start,
      results,
      nextOffset: nextOffset < session.results.length ? nextOffset : null,
      error: session.error,
    };
  }
}
