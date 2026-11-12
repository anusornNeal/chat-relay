// Pure, client-only selectors. No network requests or access to private data outside this view.
export function learnReviewReason(memory) {
  const positive = Number(memory?.positiveFeedback || 0);
  const negative = Number(memory?.negativeFeedback || 0);
  if (negative > positive) return { key: "feedback", label: "Negative feedback", priority: 0 };
  const status = memory?.usage?.status;
  if (status === "new") return { key: "new", label: "Not evaluated yet", priority: 1 };
  if (status === "unrated") return { key: "unrated", label: "Needs evidence", priority: 2 };
  const score = memory?.usage?.score;
  const evaluated = Number(memory?.usage?.evaluated || 0);
  if (typeof score === "number" && Number.isFinite(score) && score < 50 && evaluated >= 3) {
    return { key: "low", label: "Review usage signal", priority: 3 };
  }
  return null;
}
export function learnFocusItems(items, mode) {
  if (mode === "review") return items.filter((item) => learnReviewReason(item));
  if (mode === "used") return items.filter((item) => Number(item?.usage?.applied || 0) > 0);
  return items;
}
export function learnFocusSummary(items) {
  return {
    total: items.length,
    review: items.filter((item) => learnReviewReason(item)).length,
    used: items.filter((item) => Number(item?.usage?.applied || 0) > 0).length,
    negative: items.filter((item) => Number(item.negativeFeedback || 0) > Number(item.positiveFeedback || 0)).length,
  };
}
export function usageDirectory(accounts, query, sortMode = "calls") {
  const term = String(query || "").trim().toLocaleLowerCase();
  const matching = accounts.filter((account) => !term || [
    account.name, account.login, account.userId,
    ...(Array.isArray(account.agents) ? account.agents.flatMap((a) => [a.name, a.agentId]) : []),
  ].some((value) => String(value || "").toLocaleLowerCase().includes(term)));
  return [...matching].sort((a, b) => sortMode === "name"
    ? String(a.name || a.login || a.userId || "").localeCompare(String(b.name || b.login || b.userId || ""))
    : Number(b.calls || 0) - Number(a.calls || 0) ||
      String(a.name || a.userId || "").localeCompare(String(b.name || b.userId || "")));
}
