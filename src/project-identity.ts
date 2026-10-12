// Project names and direct children of a conventional Projects workspace share
// one account-scoped Learn identity. Nested paths are deliberately left intact:
// the directory may be a different repository or project.
export function canonicalLearnProjectKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const path = raw.replace(/\\/g, "/");
  const absolute = /^[a-z]:\//i.test(path) || path.startsWith("/");
  if (absolute) {
    const segments = path.split("/").filter(Boolean);
    const leaf = segments[segments.length - 1];
    const parent = segments[segments.length - 2];
    if (parent?.toLowerCase() === "projects" && leaf && leaf !== "." && leaf !== "..") {
      return leaf.toLowerCase();
    }
    return raw;
  }
  // Preserve free-form project names, but make common ASCII slug keys stable.
  return /^[a-z0-9._-]+$/i.test(raw) ? raw.toLowerCase() : raw;
}
