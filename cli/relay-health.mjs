export const RELAY_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const RELAY_HEALTH_CHECK_TIMEOUT_MS = 8 * 1000;

const MAX_RESPONSE_BYTES = 4096;

async function readResponseText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return String(await response.text()).slice(0, MAX_RESPONSE_BYTES);

  const chunks = [];
  let length = 0;
  while (length < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_BYTES - length;
    const chunk = value.subarray(0, remaining);
    chunks.push(chunk);
    length += chunk.byteLength;
    if (chunk.byteLength < value.byteLength) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  await reader.cancel().catch(() => {});

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function classifyResponse(response, body) {
  const cloudflareError = body.match(/\berror(?:\s+code)?\s*[:#]?\s*(1\d{3})\b/i);
  if (cloudflareError) {
    const code = Number(cloudflareError[1]);
    return code === 1027
      ? { state: "limited", code }
      : { state: "cloudflare-error", code };
  }
  if (response.status === 401) return { state: "unauthorized", code: response.status };
  if (response.status === 403) return { state: "unauthorized", code: response.status };
  if (response.status === 429) return { state: "limited", code: 429 };

  try {
    const health = JSON.parse(body);
    if (health?.error === "relay_unavailable") return { state: "unavailable", reason: "relay_unavailable" };
    if (!response.ok) return { state: "unavailable", code: response.status };
    if (health?.reauthorizationRequired === true) return { state: "reauthorize" };
    if (health?.authorized === false) {
      return health?.enabled === false
        ? { state: "agent-disabled" }
        : { state: "agent-access" };
    }
    if (health?.online === true) return { state: "reachable" };
    if (health?.online === false) return { state: "unavailable", reason: "agent_offline" };
  } catch {}
  if (!response.ok) return { state: "unavailable", code: response.status };
  return { state: "unavailable", code: response.status };
}

export async function checkRelayHealth(relayUrl, {
  fetchImpl = globalThis.fetch,
  userToken,
  agentId,
  signal,
  timeoutMs = RELAY_HEALTH_CHECK_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return { state: "unavailable" };

  let healthUrl;
  try {
    healthUrl = new URL(relayUrl);
    if (healthUrl.protocol !== "http:" && healthUrl.protocol !== "https:") {
      return { state: "unavailable" };
    }
    healthUrl.pathname = `${healthUrl.pathname.replace(/\/+$/, "")}/status`;
    healthUrl.search = "";
    if (agentId) healthUrl.searchParams.set("agentId", String(agentId));
    healthUrl.hash = "";
  } catch {
    return { state: "unavailable" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || RELAY_HEALTH_CHECK_TIMEOUT_MS));
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(userToken ? { authorization: `Bearer ${userToken}` } : {}),
      },
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readResponseText(response);
    return classifyResponse(response, body);
  } catch {
    return { state: "unavailable" };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function startRelayHealthMonitor(relayUrl, {
  onStatus,
  // Per active TUI, this adds 288 Worker requests and up to 864 DO fetches daily.
  intervalMs = RELAY_HEALTH_CHECK_INTERVAL_MS,
  ...checkOptions
} = {}) {
  let stopped = false;
  let timer = null;
  let activeRequest = null;
  let rerunRequested = false;

  const check = async () => {
    if (stopped || activeRequest) return;
    const controller = new AbortController();
    activeRequest = controller;
    const result = await checkRelayHealth(relayUrl, { ...checkOptions, signal: controller.signal });
    const shouldRerun = rerunRequested;
    rerunRequested = false;
    activeRequest = null;
    if (stopped) return;
    if (!shouldRerun) {
      try { onStatus?.(result); } catch {}
    }
    timer = setTimeout(check, shouldRerun ? 0 : Math.max(1000, Number(intervalMs) || RELAY_HEALTH_CHECK_INTERVAL_MS));
    timer.unref?.();
  };

  void check();
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    activeRequest?.abort();
  };
  stop.checkNow = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    if (activeRequest) {
      rerunRequested = true;
      return;
    }
    void check();
  };
  return stop;
}
