export const MAX_BYTES = 64 * 1024;

export const error = (status: number, code: string, details?: unknown) =>
  Response.json({ error: code, ...(details === undefined ? {} : { details }) }, { status });

export function hasPayload(value: unknown): value is { payload: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.hasOwn(value, "payload");
}

export async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}
