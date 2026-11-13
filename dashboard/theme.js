// Applies the saved appearance before stylesheets paint; no backend requests.
(() => {
  const key = "chat_relay_theme";
  const root = document.documentElement;
  const media = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const valid = (value) => ["light", "dark", "system"].includes(value);
  let mode = "system";
  try {
    const stored = window.localStorage.getItem(key);
    if (valid(stored)) mode = stored;
  } catch {
    // Private browsing or disabled storage must not block the dashboard.
  }

  const sync = () => {
    const effective = mode === "system" ? (media?.matches ? "dark" : "light") : mode;
    root.dataset.theme = effective;
    root.dataset.themeMode = mode;
    root.style.colorScheme = effective;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", effective === "dark" ? "#101827" : "#f8fafc",
    );
    document.querySelectorAll("[data-theme-control]").forEach((select) => {
      if (select.value !== mode) select.value = mode;
    });
  };

  const select = (value) => {
    if (!valid(value)) return;
    mode = value;
    try { window.localStorage.setItem(key, mode); } catch {}
    sync();
  };

  media?.addEventListener?.("change", () => {
    if (mode === "system") sync();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    mode = valid(event.newValue) ? event.newValue : "system";
    sync();
  });
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-control]").forEach((control) => {
      control.addEventListener("change", () => select(control.value));
    });
    sync();
  });
  sync();
})();
