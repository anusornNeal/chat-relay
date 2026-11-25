// Opt-in response packing only: preserve each match and its original preview range.
const size = value => Buffer.byteLength(JSON.stringify(value), "utf8");

export function deduplicateSearchPreviews(results) {
  const byPath = new Map();
  for (const [rowIndex, row] of results.entries()) {
    if (!row.ok || row.op !== "search" || !Array.isArray(row.result?.results)) continue;
    for (const [matchIndex, match] of row.result.results.entries()) {
      const preview = match.preview;
      if (!match.path || !preview || typeof preview.content !== "string" ||
          !Number.isInteger(preview.offset) || !Number.isInteger(preview.length) || preview.length < 1) continue;
      const lines = preview.content.split("\n");
      if (lines.length !== preview.length) continue;
      const group = byPath.get(match.path) || [];
      group.push({ rowIndex, matchIndex, preview, lines });
      byPath.set(match.path, group);
    }
  }

  const sharedPreviews = [];
  const references = new Map();
  for (const [filePath, previews] of byPath) {
    if (previews.length < 2) continue;
    previews.sort((a, b) => a.preview.offset - b.preview.offset);
    let group = null;
    const emit = () => {
      if (!group || group.members.length < 2) return;
      const id = "p" + (sharedPreviews.length + 1);
      const shared = { id, path: filePath, offset: group.offset, length: group.lines.length,
        content: group.lines.join("\n") };
      const replacements = group.members.map(member => {
        const { content, ...metadata } = member.preview;
        return { member, preview: { ...metadata, ref: id } };
      });
      // Short previews can cost more as references. Keep them inline in that case.
      if (size(shared) + size(replacements.map(x => x.preview)) >=
          size(group.members.map(x => x.preview))) return;
      sharedPreviews.push(shared);
      for (const { member, preview } of replacements) {
        references.set(member.rowIndex + ":" + member.matchIndex, preview);
      }
    };
    for (const item of previews) {
      const offset = item.preview.offset;
      const start = group ? offset - group.offset : 0;
      const overlap = group ? Math.min(group.lines.length - start, item.lines.length) : 0;
      // Never combine inconsistent snapshots (e.g. a file changed during the batch).
      const compatible = group && overlap > 0 && item.preview.totalLines === group.totalLines &&
        item.lines.slice(0, overlap).every((line, index) => line === group.lines[start + index]);
      if (compatible) {
        if (start + item.lines.length > group.lines.length) group.lines.push(...item.lines.slice(overlap));
        group.members.push(item);
      } else {
        emit();
        group = { offset, lines: [...item.lines], totalLines: item.preview.totalLines, members: [item] };
      }
    }
    emit();
  }
  if (!sharedPreviews.length) return { results };
  const packed = results.map((row, rowIndex) => {
    if (!row.ok || row.op !== "search") return row;
    return { ...row, result: { ...row.result, results: row.result.results.map((match, matchIndex) => {
      const preview = references.get(rowIndex + ":" + matchIndex);
      return preview ? { ...match, preview } : match;
    }) } };
  });
  const candidate = { results: packed, sharedPreviews };
  return size(candidate) < size({ results }) ? candidate : { results };
}
