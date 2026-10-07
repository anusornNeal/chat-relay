import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleDeviceAuth } from "./device-auth";
import { handleOAuth, oauthChallenge, oauthResource } from "./oauth";
import { browserSessionUser, handleAdmin } from "./admin";
import { hashToken, newToken, normalizeAgentId, type Scope } from "./registry";
import type { UsageEvent } from "./usage";
import { DailyOptionalBudget } from "./usage-budget.mjs";
import { AGENT_PROTOCOL_VERSION } from "./agent-state";
import { handleStatusRequest } from "./status-route.mjs";
import { error, hasPayload, readJson } from "./http-utils";
import type { LearnChange, LearnRecord } from "./learning";
import { preferredAgentForContext, routingContext } from "./context-routing";
import { buildLearnRelevanceContext, buildRelevantLearnEnvelope, type LearnScopeSelector } from "./learning-relevance";
import { LEARN_BASELINE_CONTEXT } from "./learning-policy";
import type { AuthUser, Env } from "./env";
import packageMetadata from "../package.json";

const SERVICE_VERSION = String(packageMetadata.version || "0.0.0");

function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global"));
}

async function registryCall(env: Env, path: string, body?: unknown): Promise<Response> {
  return registryStub(env).fetch(new Request(`https://registry.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function registryJson<T = any>(env: Env, path: string, body?: unknown): Promise<{ response: Response; data: T }> {
  const response = await registryCall(env, path, body);
  const data = await response.json() as T;
  return { response, data };
}


function usageStub(env: Env) {
  return env.USAGE.get(env.USAGE.idFromName("global"));
}

function dashboardStub(env: Env) {
  return env.DASHBOARD.get(env.DASHBOARD.idFromName("global"));
}

function auditStub(env: Env) {
  return env.AUDIT.get(env.AUDIT.idFromName("global"));
}

function learningStub(env: Env, user: AuthUser) {
  return env.LEARNING.get(env.LEARNING.idFromName(user.id));
}

async function learningCall(env: Env, user: AuthUser, path: string, body: unknown) {
  const response = await learningStub(env, user).fetch(new Request(`https://learning.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { ok: response.ok, body: await response.text(), statusCode: response.status };
}

type LearnPrepareArgs = {
  query: string;
  toolHint?: string;
  projectKey?: string;
  agentId?: string;
  path?: string;
  cwd?: string;
  limit?: number;
};

function normalizeLearnPrepareProjectKey(value: unknown) {
  const projectKey = String(value ?? "").trim().slice(0, 200);
  return projectKey || null;
}

function normalizeLearnPrepareAgentId(value: unknown) {
  const agentId = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(agentId) ? agentId : null;
}

async function readLearnPrepareScopes(
  env: Env,
  user: AuthUser,
  scopes: LearnScopeSelector[],
): Promise<{ ok: true; items: LearnRecord[] } | { ok: false; statusCode: number }> {
  const call = await learningCall(env, user, "/get", {
    scopes,
    limit: 64,
    perKind: 4,
    routingReserve: 24,
  });
  if (!call.ok) return { ok: false, statusCode: call.statusCode };
  try {
    const data = JSON.parse(call.body) as { items?: LearnRecord[] };
    return { ok: true, items: Array.isArray(data.items) ? data.items.slice(0, 100) : [] };
  } catch {
    return { ok: false, statusCode: 502 };
  }
}

async function prepareLearnContext(
  env: Env,
  user: AuthUser,
  args: LearnPrepareArgs,
): Promise<{ ok: boolean; body: string; statusCode?: number }> {
  const globalScope: LearnScopeSelector = { scope: "global" };
  const globalRead = await readLearnPrepareScopes(env, user, [globalScope]);
  if (!globalRead.ok) {
    return { ok: false, statusCode: globalRead.statusCode, body: JSON.stringify({ error: "learning_unavailable" }) };
  }

  const records: LearnRecord[] = [...globalRead.items];
  const activeScopes: LearnScopeSelector[] = [globalScope];
  let route = routingContext(args, records);
  const explicitProjectKey = normalizeLearnPrepareProjectKey(args.projectKey);
  const projectKey = explicitProjectKey ?? route.projectKey ?? null;

  if (projectKey) {
    const projectScope: LearnScopeSelector = { scope: "project", scopeKey: projectKey };
    const projectRead = await readLearnPrepareScopes(env, user, [projectScope]);
    if (!projectRead.ok) {
      return { ok: false, statusCode: projectRead.statusCode, body: JSON.stringify({ error: "learning_unavailable" }) };
    }
    activeScopes.push(projectScope);
    records.push(...projectRead.items);
  }

  const preferredAgent = preferredAgentForContext(records, projectKey);
  const explicitAgentId = normalizeLearnPrepareAgentId(args.agentId);
  const agentId = explicitAgentId ?? preferredAgent?.agentId ?? null;
  if (agentId) {
    const agentScope: LearnScopeSelector = { scope: "agent", scopeKey: agentId };
    const agentRead = await readLearnPrepareScopes(env, user, [agentScope]);
    if (!agentRead.ok) {
      return { ok: false, statusCode: agentRead.statusCode, body: JSON.stringify({ error: "learning_unavailable" }) };
    }
    activeScopes.push(agentScope);
    records.push(...agentRead.items);
  }

  const deduped = [...new Map(records.map((record) => [record.id, record])).values()];
  const relevance = buildLearnRelevanceContext(
    args.toolHint || "learn_prepare",
    args,
    projectKey,
    agentId,
    args.query,
  );
  const preparedContext = buildRelevantLearnEnvelope(
    deduped,
    activeScopes,
    relevance,
    args.limit ?? 16,
  ) ?? {
    version: 1 as const,
    authority: "advisory" as const,
    instructionPolicy: "non-authoritative" as const,
    activated: activeScopes,
    items: [],
  };

  return {
    ok: true,
    body: JSON.stringify({
      mode: "explicit-one-shot",
      preparedContext,
      routingContext: {
        projectKey,
        projectSource: projectKey ? (explicitProjectKey ? "explicit" : "project-root") : null,
        agentId,
        agentSource: agentId ? (explicitAgentId ? "explicit" : preferredAgent?.source ?? "preferred") : null,
      },
      guidance: "Reuse this prepared context for the current task. Do not call learn_prepare before every tool.",
    }),
  };
}

function safeAuthReason(value: unknown, fallback: string): string {
  const reason = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_.:-]{0,79}$/.test(reason) ? reason : fallback;
}

async function recordConnectorAuthEvent(
  env: Env,
  action: string,
  result: "success" | "failure",
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await auditStub(env).fetch(new Request("https://audit.internal/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { kind: "anonymous" },
        action,
        target: { type: "connector_auth" },
        result,
        metadata,
      }),
    }));
  } catch {}
}

async function recordConnectorAuthFailure(
  env: Env,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  return recordConnectorAuthEvent(env, action, "failure", metadata);
}

function connectorAuthorizeTelemetry(
  request: Request,
  response: Response,
  hasBrowserSession: boolean,
): Record<string, unknown> {
  const url = new URL(request.url);
  let redirectHost = "";
  try {
    redirectHost = new URL(url.searchParams.get("redirect_uri") || "").hostname.slice(0, 120);
  } catch {}
  const userAgent = request.headers.get("user-agent") || "";
  return {
    status: response.status,
    route: url.pathname,
    mobile: /android|iphone|ipad|mobile/i.test(userAgent),
    hasBrowserSession,
    recoveryRequested: url.searchParams.get("recovery") === "1",
    ...(redirectHost ? { redirectHost } : {}),
  };
}

async function recordOAuthTokenFailure(
  env: Env,
  request: Request,
  response: Response,
): Promise<void> {
  const form = await request.formData().catch(() => null);
  const data = await response.json<any>().catch(() => ({}));
  const grantType = safeAuthReason(form?.get("grant_type"), "unknown");
  const action = grantType === "refresh_token"
    ? "connector.oauth.refresh.failure"
    : grantType === "authorization_code"
      ? "connector.oauth.code_exchange.failure"
      : "connector.oauth.token.failure";
  await recordConnectorAuthFailure(env, action, {
    status: response.status,
    grantType,
    reason: safeAuthReason(data.reason ?? data.error, "oauth_token_failure"),
    oauthError: safeAuthReason(data.error, "unknown"),
  });
}

export async function publishDashboard(env: Env, topics: string[]): Promise<void> {
  try {
    await dashboardStub(env).fetch(new Request("https://dashboard.internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topics }),
    }));
  } catch {}
}

type SafeTiming = {
  workerOverheadMs?: number;
  relayRoundTripMs?: number;
  transportMs?: number;
  agentQueueWaitMs?: number;
  agentHandlerMs?: number;
  desktopQueueWaitMs?: number;
  desktopInputMs?: number;
  desktopExplicitWaitMs?: number;
  desktopSettleMs?: number;
  desktopCaptureMs?: number;
  desktopEncodeMs?: number;
  desktopWorkerMs?: number;
  desktopManagerMs?: number;
  desktopTotalMs?: number;
};

function safeTimingMs(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(Math.max(0, Math.round(numeric)), 120_000);
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(code)) return undefined;
  return code.toLowerCase();
}

type SafeToolFailure = {
  errorClass?: string;
  errorSource?: string;
  errorCode?: string;
};

function failureMetadata(call: { ok: boolean; errorSource?: string; errorCode?: string }): SafeToolFailure {
  if (call.ok) return {};
  return {
    errorClass: call.errorCode || "tool_error",
    errorSource: call.errorSource || "agent",
    ...(call.errorCode ? { errorCode: call.errorCode } : {}),
  };
}

type ToolActivityContext = {
  toolCallId: string;
  activityId?: string;
  startedAt: string;
  executionCtx?: ExecutionContext;
};

const toolActivityContexts = new WeakMap<object, ToolActivityContext>();

const recentLearnAgentByUser = new Map<string, string>();
const RECENT_LEARN_AGENT_MAX = 512;

function noteRecentLearnAgent(userId: string, agentId: string) {
  const userKey = String(userId || "").slice(0, 128);
  const agentKey = String(agentId || "").trim().slice(0, 128);
  if (!userKey || !agentKey) return;
  recentLearnAgentByUser.delete(userKey);
  recentLearnAgentByUser.set(userKey, agentKey);
  while (recentLearnAgentByUser.size > RECENT_LEARN_AGENT_MAX) {
    const oldest = recentLearnAgentByUser.keys().next().value;
    if (oldest === undefined) break;
    recentLearnAgentByUser.delete(oldest);
  }
}

type LearningMutationPayload = {
  changed?: boolean;
  change?: LearnChange | null;
};

type LearnActivityTool = "learn_prepare" | "learn_get" | "learn_put" | "learn_delete" | "learn_feedback";

const LEARN_ACTIVITY_TOOLS = new Set<LearnActivityTool>([
  "learn_prepare",
  "learn_get",
  "learn_put",
  "learn_delete",
  "learn_feedback",
]);

function readLearningMutationChange(
  call: { ok: boolean; body: string; statusCode: number },
): LearnChange | null {
  if (!call.ok) return null;
  let data: LearningMutationPayload;
  try { data = JSON.parse(call.body) as LearningMutationPayload; }
  catch { return null; }
  return data.changed && data.change ? data.change : null;
}

async function learningMutationCall(
  env: Env,
  user: AuthUser,
  path: "/put" | "/delete" | "/feedback",
  args: unknown,
) {
  const call = await learningCall(env, user, path, args);
  return { call, learnChange: readLearningMutationChange(call) };
}

function learnActivityScopeSummary(tool: LearnActivityTool, args: unknown): string | null {
  const input = args && typeof args === "object" ? args as any : {};
  if (tool === "learn_prepare") {
    const scopes = ["global"];
    if (String(input.projectKey ?? "").trim()) scopes.push("project");
    if (normalizeLearnPrepareAgentId(input.agentId)) scopes.push("agent");
    return scopes.join("/");
  }
  if (tool !== "learn_get" || !Array.isArray(input.scopes)) return null;
  const scopes = [...new Set(input.scopes
    .map((entry: any) => String(entry?.scope ?? "").trim())
    .filter((scope: string) => scope === "global" || scope === "project" || scope === "agent"))];
  return scopes.length ? scopes.join("/") : null;
}

function compactLearnChange(change: LearnChange | null | undefined) {
  if (!change) return null;
  return {
    eventId: change.eventId,
    memoryId: change.memoryId,
    type: change.type,
    key: change.key,
    kind: change.kind,
    scope: change.scope,
    scopeKey: change.scopeKey,
    confidence: change.confidence,
    previousConfidence: change.previousConfidence,
    at: change.at,
  };
}

async function publishLearnToolActivity(
  env: Env,
  user: AuthUser,
  tool: LearnActivityTool,
  args: unknown,
  result: { ok: boolean; durationMs: number; learnChange?: LearnChange | null },
  executionCtx?: ExecutionContext,
) {
  const input = args && typeof args === "object" ? args as any : {};
  const explicitAgentId = normalizeLearnPrepareAgentId(input.agentId);
  if (explicitAgentId) noteRecentLearnAgent(user.id, explicitAgentId);
  const agentId = explicitAgentId ?? recentLearnAgentByUser.get(user.id) ?? null;
  if (!agentId) return;

  const scopeSummary = learnActivityScopeSummary(tool, args);
  const kind = typeof input.kind === "string" ? input.kind.slice(0, 40) : null;
  const feedback = tool === "learn_feedback" && (input.value === "positive" || input.value === "negative")
    ? input.value
    : null;
  const change = compactLearnChange(result.learnChange);
  try {
    const delivery = env.RELAY.get(env.RELAY.idFromName(agentId)).fetch(new Request("https://relay.internal/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        control: "learn_activity",
        activity: {
          eventId: "learn-call-" + crypto.randomUUID(),
          tool,
          ok: result.ok,
          durationMs: Math.max(0, Math.round(result.durationMs)),
          at: new Date().toISOString(),
          ...(scopeSummary ? { scopeSummary } : {}),
          ...(kind ? { kind } : {}),
          ...(feedback ? { feedback } : {}),
          ...(change ? { change } : {}),
        },
      }),
    })).catch(() => undefined);

    if (executionCtx) {
      try { executionCtx.waitUntil(delivery.then(() => undefined)); } catch {}
      return;
    }
    await delivery;
  } catch {}
}

const SECURITY_CACHE_TTL_MS = 30 * 60_000;
const SECURITY_REVISION_POLL_MS = 30_000;
const SECURITY_CACHE_MAX_ENTRIES = 512;
const ADMIN_SECURITY_MUTATION_PATHS = new Set([
  "/admin/bootstrap",
  "/admin/users",
  "/admin/agents",
  "/admin/grants",
  "/admin/grants/delete",
  "/admin/users/enabled",
  "/admin/agents/enabled",
  "/admin/users/rotate",
  "/admin/agents/rotate",
  "/admin/api/users/soft-delete",
  "/admin/api/users/restore",
  "/admin/api/users/admin",
  "/admin/api/agents/retire",
  "/admin/api/sessions/revoke",
]);
type TimedSecurityCacheEntry<T> = { value: T; expiresAt: number };
type ResolvedAgentAccess = { agentId: string; scopes: string[] };

const authUserCache = new Map<string, TimedSecurityCacheEntry<AuthUser>>();
const resolvedAgentCache = new Map<string, TimedSecurityCacheEntry<ResolvedAgentAccess>>();
let knownSecurityRevision: number | null = null;
let securityRevisionCheckedAt = 0;
let securityRevisionCheckPromise: Promise<void> | null = null;
const usageRecordBudget = new DailyOptionalBudget();
const USAGE_BATCH_MAX_EVENTS = 96;
const USAGE_BATCH_DELAY_MS = 3_000;
const usageEventBuffer: UsageEvent[] = [];
let usageFlushPromise: Promise<void> | null = null;
let usageFlushWake: (() => void) | null = null;

function securityCacheGet<T>(cache: Map<string, TimedSecurityCacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function securityCachePut<T>(cache: Map<string, TimedSecurityCacheEntry<T>>, key: string, value: T) {
  if (cache.size >= SECURITY_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + SECURITY_CACHE_TTL_MS });
}

function invalidateLocalSecurityCaches() {
  authUserCache.clear();
  resolvedAgentCache.clear();
  knownSecurityRevision = null;
  securityRevisionCheckedAt = 0;
}

function noteSecurityRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  if (knownSecurityRevision !== null && knownSecurityRevision !== revision) {
    authUserCache.clear();
    resolvedAgentCache.clear();
  }
  knownSecurityRevision = revision;
  securityRevisionCheckedAt = Date.now();
}

async function ensureSecurityRevisionFresh(env: Env) {
  const now = Date.now();
  if (now - securityRevisionCheckedAt < SECURITY_REVISION_POLL_MS) return;
  if (securityRevisionCheckPromise) return securityRevisionCheckPromise;

  securityRevisionCheckPromise = (async () => {
    const checkedAt = Date.now();
    try {
      const { response, data } = await registryJson<{ revision?: number }>(env, "/security/revision");
      if (!response.ok || !Number.isSafeInteger(data.revision)) {
        invalidateLocalSecurityCaches();
        securityRevisionCheckedAt = checkedAt;
        return;
      }
      noteSecurityRevision(data.revision);
    } catch {
      invalidateLocalSecurityCaches();
      securityRevisionCheckedAt = checkedAt;
    }
  })();

  try {
    await securityRevisionCheckPromise;
  } finally {
    securityRevisionCheckPromise = null;
  }
}

function grantAllows(scopes: string[], required: Scope) {
  return scopes.includes("*") || scopes.includes(required);
}

async function activityContextForRequest(request: Request): Promise<ToolActivityContext> {
  const activitySource = [
    "mcp-session-id",
    "x-openai-conversation-id",
    "x-openai-chat-id",
    "x-chatgpt-conversation-id",
  ].map((name) => request.headers.get(name)?.trim()).find(Boolean);

  const activityId = activitySource
    ? "act_" + (await hashToken("chat-relay-activity:" + activitySource)).slice(0, 20)
    : undefined;

  return {
    toolCallId: "tc_" + crypto.randomUUID().replace(/-/g, ""),
    ...(activityId ? { activityId } : {}),
    startedAt: new Date().toISOString(),
  };
}

async function flushUsageEvents(env: Env) {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (usageFlushWake === done) usageFlushWake = null;
      resolve();
    };
    const timer = setTimeout(done, USAGE_BATCH_DELAY_MS);
    usageFlushWake = done;
  });

  while (usageEventBuffer.length) {
    const events = usageEventBuffer.splice(0, USAGE_BATCH_MAX_EVENTS);
    try {
      await usageStub(env).fetch(new Request("https://usage.internal/record-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      }));
    } catch {}
  }
}

async function recordUsage(
  env: Env,
  event: UsageEvent,
  executionCtx?: ExecutionContext,
): Promise<void> {
  const budget = usageRecordBudget.consume(env.USAGE_RECORD_DAILY_BUDGET);
  if (!budget.allowed) return;

  usageEventBuffer.push(event);
  if (!usageFlushPromise) {
    usageFlushPromise = flushUsageEvents(env).finally(() => {
      usageFlushPromise = null;
      usageFlushWake = null;
    });
  }

  executionCtx?.waitUntil(usageFlushPromise);
  if (!executionCtx || usageEventBuffer.length >= USAGE_BATCH_MAX_EVENTS) {
    usageFlushWake?.();
  }
}


async function flushPendingUsage(env: Env): Promise<void> {
  const pending = usageFlushPromise;
  if (!pending) return;
  usageFlushWake?.();
  await pending;
}

type InstrumentToolOutcome<T> = {
  value: T;
  ok: boolean;
  agentId?: string;
  errorClass?: string;
  errorSource?: string;
  errorCode?: string;
  statusCode?: number;
  exitCode?: number | null;
  timing?: SafeTiming;
  learnChange?: LearnChange | null;
};

async function instrumentTool<T>(
  env: Env,
  user: AuthUser,
  tool: string,
  args: unknown,
  run: () => Promise<InstrumentToolOutcome<T>>,
): Promise<T> {
  const startedAtMs = Date.now();
  const executionCtx = toolActivityContexts.get(user)?.executionCtx;
  const requestedAgentId = typeof args === "object" && args !== null && typeof (args as any).agentId === "string"
    ? String((args as any).agentId).slice(0, 128)
    : undefined;
  let outcome: InstrumentToolOutcome<T> | undefined;
  try {
    outcome = await run();

    if (outcome.agentId && (outcome.ok || outcome.errorSource === "agent")) {
      noteRecentLearnAgent(user.id, outcome.agentId);
    }

    if (LEARN_ACTIVITY_TOOLS.has(tool as LearnActivityTool)) {
      await publishLearnToolActivity(env, user, tool as LearnActivityTool, args, {
        ok: outcome.ok,
        durationMs: Date.now() - startedAtMs,
        learnChange: outcome.learnChange,
      }, executionCtx);
    }

    return outcome.value;
  } catch (cause) {
    if (LEARN_ACTIVITY_TOOLS.has(tool as LearnActivityTool)) {
      await publishLearnToolActivity(env, user, tool as LearnActivityTool, args, {
        ok: false,
        durationMs: Date.now() - startedAtMs,
      }, executionCtx);
    }
    await recordUsage(env, {
      userId: user.id,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      timestamp: new Date().toISOString(),
      tool,
      durationMs: Date.now() - startedAtMs,
      ok: false,
      errorClass: cause instanceof Error ? cause.name.slice(0, 80) : "tool_exception",
      errorSource: "worker",
      errorCode: "tool_exception",
    }, executionCtx);
    throw cause;
  } finally {
    if (outcome) {
      await recordUsage(env, {
        userId: user.id,
        ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
        timestamp: new Date().toISOString(),
        tool,
        durationMs: Date.now() - startedAtMs,
        ok: outcome.ok,
        ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        ...(outcome.errorSource ? { errorSource: outcome.errorSource } : {}),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.timing?.workerOverheadMs !== undefined ? { workerOverheadMs: outcome.timing.workerOverheadMs } : {}),
        ...(outcome.timing?.relayRoundTripMs !== undefined ? { relayRoundTripMs: outcome.timing.relayRoundTripMs } : {}),
        ...(outcome.timing?.transportMs !== undefined ? { transportMs: outcome.timing.transportMs } : {}),
        ...(outcome.timing?.agentQueueWaitMs !== undefined ? { agentQueueWaitMs: outcome.timing.agentQueueWaitMs } : {}),
        ...(outcome.timing?.agentHandlerMs !== undefined ? { agentHandlerMs: outcome.timing.agentHandlerMs } : {}),
      }, executionCtx);
    }
  }
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

async function authenticateUserResult(
  request: Request,
  env: Env,
): Promise<{ user: AuthUser | null; response?: Response; reason?: string }> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("key");
  const headerToken = bearerToken(request);
  const token = queryToken || headerToken;
  if (!token) return { user: null };
  const tokenHash = await hashToken(token);
  const resource = !queryToken && headerToken && url.pathname === "/mcp"
    ? oauthResource(request)
    : undefined;
  const cacheKey = tokenHash + "|" + (resource || "");
  const cached = securityCacheGet(authUserCache, cacheKey);
  if (cached) {
    await ensureSecurityRevisionFresh(env);
    const fresh = securityCacheGet(authUserCache, cacheKey);
    if (fresh) return { user: fresh };
  }
  const { response, data } = await registryJson<{
    user?: AuthUser;
    reason?: string;
    error?: string;
    securityRevision?: number;
  }>(env, "/auth/user", {
    tokenHash,
    ...(resource ? { resource } : {}),
  });
  noteSecurityRevision(data.securityRevision);
  if (!response.ok || !data.user) {
    return {
      user: null,
      response,
      reason: safeAuthReason(data.reason ?? data.error, "unauthorized"),
    };
  }
  securityCachePut(authUserCache, cacheKey, data.user);
  return { user: data.user };
}

async function authenticateUser(request: Request, env: Env): Promise<AuthUser | null> {
  return (await authenticateUserResult(request, env)).user;
}

async function authenticateAgent(request: Request, env: Env, agentId: string): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const tokenHash = await hashToken(token);
  const { response } = await registryJson(env, "/auth/agent", { tokenHash, agentId });
  return response.ok;
}

async function resolveAgent(
  env: Env,
  userId: string,
  scope: Scope,
  requestedAgentId?: string,
): Promise<{ ok: true; agentId: string; scopes: string[]; securityRevision?: number } | { ok: false; response: Response }> {
  const { response, data } = await registryJson<any>(env, "/resolve", {
    userId,
    scope,
    agentId: requestedAgentId,
  });
  if (!response.ok) {
    return { ok: false, response: Response.json(data, { status: response.status }) };
  }
  return {
    ok: true,
    agentId: data.agent.id,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    securityRevision: Number.isSafeInteger(data.securityRevision) ? data.securityRevision : undefined,
  };
}

function scopeForAction(action: string): Scope {
  if (action.startsWith("fs.write") || action.startsWith("fs.edit") ||
      action.startsWith("fs.mkdir") || action.startsWith("fs.move") ||
      action.startsWith("fs.delete")) return "write";
  if (action.startsWith("terminal.")) return "terminal";
  if (["agent.lifecycle.drain", "agent.lifecycle.resume", "agent.lifecycle.restart", "agent.lifecycle.upgrade"].includes(action)) return "process";
  if (action === "process.kill" || action === "process.list") return "process";
  if (action === "desktop.screenshot") return "desktop_read";
  if (action === "desktop.mouse.click" || action === "desktop.keyboard.input" || action === "desktop.step") return "desktop_control";
  return "read";
}

async function resolveAgentForScopes(
  env: Env,
  userId: string,
  scopes: Scope[],
  requestedAgentId?: string,
): Promise<{ ok: true; agentId: string } | { ok: false; response: Response }> {
  const uniqueScopes = [...new Set(scopes)].sort();
  const cacheKey = userId + "|" + (requestedAgentId || "auto") + "|" + uniqueScopes.join(",");
  const cached = securityCacheGet(resolvedAgentCache, cacheKey);
  if (cached) {
    await ensureSecurityRevisionFresh(env);
    const fresh = securityCacheGet(resolvedAgentCache, cacheKey);
    if (fresh && uniqueScopes.every(scope => grantAllows(fresh.scopes, scope))) {
      return { ok: true, agentId: fresh.agentId };
    }
  }

  const firstScope = uniqueScopes[0] || "read";
  const resolved = await resolveAgent(env, userId, firstScope, requestedAgentId);
  if (!resolved.ok) return resolved;
  noteSecurityRevision(resolved.securityRevision);
  if (!uniqueScopes.every(scope => grantAllows(resolved.scopes, scope))) {
    return { ok: false, response: Response.json({ error: "permission_denied" }, { status: 403 }) };
  }
  securityCachePut(resolvedAgentCache, cacheKey, { agentId: resolved.agentId, scopes: resolved.scopes });
  return { ok: true, agentId: resolved.agentId };
}

async function callAgent(
  env: Env,
  user: AuthUser,
  scope: Scope | Scope[],
  requestedAgentId: string | undefined,
  payload: unknown,
) {
  const scopes = Array.isArray(scope) ? scope : [scope];
  const resolved = await resolveAgentForScopes(env, user.id, scopes, requestedAgentId);
  if (!resolved.ok) {
    const body = await resolved.response.text();
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(body) as any;
      errorCode = safeErrorCode(parsed?.errorCode) || safeErrorCode(parsed?.error);
    } catch {}
    return {
      ok: false,
      body,
      agentId: requestedAgentId,
      statusCode: resolved.response.status,
      errorSource: "relay",
      errorCode: errorCode || ("http_" + resolved.response.status),
    };
  }

  const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
  const workerStartedAt = Date.now();
  const response = await stub.fetch(new Request("https://relay.internal/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload }),
  }));
  const body = await response.text();

  let ok = response.ok;
  let exitCode: number | null | undefined;
  let errorCode: string | undefined;
  let errorSource: string | undefined;
  let timing: SafeTiming | undefined;
  try {
    const parsed = JSON.parse(body) as any;
    const payload = parsed?.payload;
    const relayRoundTripMs = safeTimingMs(parsed?.meta?.relayRoundTripMs);
    const transportMs = safeTimingMs(parsed?.meta?.transportMs);
    const agentQueueWaitMs = safeTimingMs(parsed?.meta?.agentQueueWaitMs);
    const agentHandlerMs = safeTimingMs(parsed?.meta?.agentHandlerMs);
    const desktopQueueWaitMs = safeTimingMs(payload?.timing?.queueWaitMs);
    const desktopInputMs = safeTimingMs(payload?.timing?.inputMs);
    const desktopExplicitWaitMs = safeTimingMs(payload?.timing?.explicitWaitMs);
    const desktopSettleMs = safeTimingMs(payload?.timing?.settleMs);
    const desktopCaptureMs = safeTimingMs(payload?.timing?.captureMs);
    const desktopEncodeMs = safeTimingMs(payload?.timing?.encodeMs);
    const desktopWorkerMs = safeTimingMs(payload?.timing?.workerMs);
    const desktopManagerMs = safeTimingMs(payload?.timing?.managerMs);
    const desktopTotalMs = safeTimingMs(payload?.timing?.totalMs);
    const workerTotalMs = Math.max(0, Date.now() - workerStartedAt);
    timing = {
      ...(relayRoundTripMs === undefined ? {} : { relayRoundTripMs }),
      ...(transportMs === undefined ? {} : { transportMs }),
      ...(agentQueueWaitMs === undefined ? {} : { agentQueueWaitMs }),
      ...(agentHandlerMs === undefined ? {} : { agentHandlerMs }),
      ...(desktopQueueWaitMs === undefined ? {} : { desktopQueueWaitMs }),
      ...(desktopInputMs === undefined ? {} : { desktopInputMs }),
      ...(desktopExplicitWaitMs === undefined ? {} : { desktopExplicitWaitMs }),
      ...(desktopSettleMs === undefined ? {} : { desktopSettleMs }),
      ...(desktopCaptureMs === undefined ? {} : { desktopCaptureMs }),
      ...(desktopEncodeMs === undefined ? {} : { desktopEncodeMs }),
      ...(desktopWorkerMs === undefined ? {} : { desktopWorkerMs }),
      ...(desktopManagerMs === undefined ? {} : { desktopManagerMs }),
      ...(desktopTotalMs === undefined ? {} : { desktopTotalMs }),
      ...(relayRoundTripMs === undefined ? {} : { workerOverheadMs: Math.max(0, workerTotalMs - relayRoundTripMs) }),
    };
    if (payload?.ok === false) ok = false;
    if (payload?.exitCode === null) exitCode = null;
    else if (Number.isFinite(Number(payload?.exitCode))) exitCode = Number(payload?.exitCode);
    if (!ok) {
      errorCode = safeErrorCode(payload?.errorCode) || safeErrorCode(payload?.error) ||
        safeErrorCode(parsed?.errorCode) || safeErrorCode(parsed?.error);
      errorSource = payload && (payload.errorCode !== undefined || payload.error !== undefined) ? "agent" : "relay";
    }
  } catch {
    if (!response.ok) errorSource = "relay";
  }
  if (!ok && !errorCode && !response.ok) errorCode = "http_" + response.status;

  return {
    ok,
    body,
    agentId: resolved.agentId,
    statusCode: response.status,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(errorSource ? { errorSource } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(timing ? { timing } : {}),
  };
}

function toolResult(result: { ok: boolean; body: string }) {
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text" as const, text: result.body }],
  };
}

async function screenshotToolResult(env: Env, agentId: string | undefined, result: { ok: boolean; body: string }) {
  if (!result.ok) return toolResult(result);
  try {
    const envelope = JSON.parse(result.body) as { payload?: any };
    const payload = envelope?.payload;
    if (!payload?.ok || payload.mimeType !== "image/jpeg" || typeof payload.data !== "string" || !agentId) {
      return toolResult({ ok: false, body: JSON.stringify({ error: payload?.error || "invalid_screenshot_result" }) });
    }

    const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
    const stored = await stub.fetch(new Request("https://relay.internal/temp-shot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: payload.mimeType, data: payload.data }),
    }));
    if (!stored.ok) {
      return toolResult({ ok: false, body: JSON.stringify({ error: "temp_screenshot_store_failed" }) });
    }

    const temp = await stored.json<any>();
    const tempPath = "/tmp-shot/" + encodeURIComponent(agentId) + "/" + temp.token;
    const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const metadata = {
      width: payload.width,
      height: payload.height,
      desktopOriginX: payload.desktopOriginX,
      desktopOriginY: payload.desktopOriginY,
      desktopWidth: payload.desktopWidth,
      desktopHeight: payload.desktopHeight,
      scaleX: payload.scaleX,
      scaleY: payload.scaleY,
      byteLength: payload.byteLength,
      monitorIndex: payload.monitorIndex,
      isPrimary: payload.isPrimary === true,
      deviceName: payload.deviceName,
      virtualDesktopOriginX: payload.virtualDesktopOriginX,
      virtualDesktopOriginY: payload.virtualDesktopOriginY,
      virtualDesktopWidth: payload.virtualDesktopWidth,
      virtualDesktopHeight: payload.virtualDesktopHeight,
      monitorCount: payload.monitorCount,
      jpegQuality: payload.jpegQuality,
      native: payload.native === true,
      tempUrl: baseUrl ? baseUrl + tempPath : tempPath,
      expiresAt: new Date(temp.expiresAt).toISOString(),
      expiresInSeconds: 300,
      ...(payload.timing && typeof payload.timing === "object" ? { timing: payload.timing } : {}),
    };

    return {
      structuredContent: metadata,
      content: [
        ...(payload.native === true ? [] : [{ type: "image" as const, data: payload.data, mimeType: payload.mimeType }]),
        { type: "text" as const, text: JSON.stringify(metadata) },
      ],
    };
  } catch {
    return toolResult({ ok: false, body: JSON.stringify({ error: "invalid_screenshot_result" }) });
  }
}

async function tempArtifactToolResult(
  env: Env,
  agentId: string | undefined,
  result: { ok: boolean; body: string },
  ttlSeconds?: number,
) {
  if (!result.ok) return toolResult(result);
  try {
    const envelope = JSON.parse(result.body) as { payload?: any };
    const payload = envelope?.payload;
    if (!payload?.ok || typeof payload.data !== "string" ||
        typeof payload.mimeType !== "string" || !agentId) {
      return toolResult({ ok: false, body: JSON.stringify({ error: payload?.error || "invalid_artifact_result" }) });
    }

    const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
    const stored = await stub.fetch(new Request("https://relay.internal/temp-artifact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mimeType: payload.mimeType,
        data: payload.data,
        filename: payload.filename,
        ttlSeconds,
      }),
    }));
    if (!stored.ok) {
      return toolResult({ ok: false, body: JSON.stringify({ error: "temp_artifact_store_failed" }) });
    }

    const temp = await stored.json<any>();
    const tempPath = "/tmp-artifact/" + encodeURIComponent(agentId) + "/" + temp.token;
    const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const metadata = {
      ok: true,
      filename: payload.filename,
      mimeType: payload.mimeType,
      byteLength: payload.byteLength,
      tempUrl: baseUrl ? baseUrl + tempPath : tempPath,
      expiresAt: new Date(temp.expiresAt).toISOString(),
      expiresInSeconds: temp.ttlSeconds,
    };
    return {
      structuredContent: metadata,
      content: [{ type: "text" as const, text: JSON.stringify(metadata) }],
    };
  } catch {
    return toolResult({ ok: false, body: JSON.stringify({ error: "invalid_artifact_result" }) });
  }
}

async function listUserAgents(env: Env, user: AuthUser) {
  const { response, data } = await registryJson<any>(env, "/list-agents", { userId: user.id });
  if (!response.ok) return { ok: false, body: JSON.stringify(data) };

  const agents = await Promise.all((data.agents ?? []).map(async (agent: any) => {
    const stub = env.RELAY.get(env.RELAY.idFromName(agent.id));
    const status = await stub.fetch("https://relay.internal/status").then((r) => r.json<any>()).catch(() => ({ online: false }));
    const { online, ...connection } = status;
    return { ...agent, online: Boolean(online), connection };
  }));

  return { ok: true, body: JSON.stringify({ user, agents }) };
}

const agentIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/).optional();
const terminalSessionIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^terminal:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
]);

const READ_ONLY_TOOLS = new Set([
  "whoami", "list_agents", "learn_prepare", "learn_get", "ping_agent", "get_config", "get_recent_tool_calls", "agent_lifecycle_status",
  "stat_path", "list_directory", "read_file", "read_multiple_files", "fs_batch",
  "start_search", "get_more_search_results", "list_processes", "screenshot", "clipboard_read", "list_windows",
  "terminal_read", "terminal_list", "terminal_batch_status", "terminal_batch_read", "read_process_output", "list_sessions",
]);
const OPEN_WORLD_TOOLS = new Set([
  "mouse_click", "keyboard_input", "desktop_step", "clipboard_write", "focus_window",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_write",
  "terminal_batch_start", "terminal_batch_cancel",
  "start_process", "interact_with_process", "upgrade_agent",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "write_file", "edit_block", "move_path", "delete_path", "kill_process", "learn_delete",
  "mouse_click", "keyboard_input", "desktop_step", "clipboard_write", "focus_window",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_write", "terminal_kill",
  "terminal_batch_start", "terminal_batch_cancel",
  "start_process", "interact_with_process", "force_terminate", "restart_agent", "upgrade_agent",
]);

function annotationsForTool(name: string, override: Record<string, boolean> = {}) {
  return {
    readOnlyHint: READ_ONLY_TOOLS.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    ...override,
  };
}

function oauthToolSecurity() {
  const securitySchemes = [{ type: "oauth2", scopes: ["mcp", "offline_access"] }];
  return {
    securitySchemes,
    _meta: { securitySchemes },
  };
}

const SCREENSHOT_UI_URI = "ui://chat-relay/screenshot-v3.html";

function createMcpServer(env: Env, user: AuthUser) {
  const server = new McpServer({ name: "chat-relay", version: SERVICE_VERSION });

  server.registerTool(
    "whoami",
    { description: "Show the authenticated relay user.", inputSchema: {}, annotations: annotationsForTool("whoami"), ...oauthToolSecurity() } as any,
    async () => instrumentTool(env, user, "whoami", {}, async () => {
      const value = toolResult({ ok: true, body: JSON.stringify({ user }) });
      return { value, ok: true };
    }),
  );

  server.registerTool(
    "list_agents",
    { description: "List agents this user can access, including scopes and online status.", inputSchema: {}, annotations: annotationsForTool("list_agents"), ...oauthToolSecurity() } as any,
    async () => instrumentTool(env, user, "list_agents", {}, async () => {
      const call = await listUserAgents(env, user);
      return { value: toolResult(call), ok: call.ok };
    }),
  );

  const learnScopeSchema = z.object({ scope: z.enum(["global", "project", "agent"]), scopeKey: z.string().min(1).max(200).optional() });
  const learnKindSchema = z.enum(["preference", "response_style", "work_style", "coding_style", "problem_solving", "project_context", "tool_pattern", "workflow", "correction", "agent_context"]);

  server.registerTool(
    "learn_prepare",
    {
      description: "Prepare relevant learned context once for the current task when prior user/project/agent context may materially affect decisions. This is explicit and read-only: call it when useful, reuse the result for the task, and do not call it before every MCP tool.",
      inputSchema: {
        query: z.string().min(1).max(1200),
        toolHint: z.string().min(1).max(80).optional(),
        projectKey: z.string().min(1).max(200).optional(),
        agentId: agentIdSchema,
        path: z.string().min(1).max(2048).optional(),
        cwd: z.string().min(1).max(2048).optional(),
        limit: z.number().int().min(1).max(32).optional(),
      },
      annotations: annotationsForTool("learn_prepare"),
      ...oauthToolSecurity(),
    } as any,
    async (args: LearnPrepareArgs) => instrumentTool(env, user, "learn_prepare", args, async () => {
      const call = await prepareLearnContext(env, user, args);
      return {
        value: toolResult(call),
        ok: call.ok,
        statusCode: call.statusCode,
        ...(call.ok ? {} : { errorSource: "worker", errorCode: "learn_prepare_failed" }),
      };
    }),
  );

  server.registerTool("learn_get", { description: "Read raw learned memories for targeted inspection or deduplication. Prefer learn_prepare once for task-level context; do not call learn_get automatically before ordinary MCP tools.", inputSchema: { scopes: z.array(learnScopeSchema).min(1).max(8), kind: learnKindSchema.optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: annotationsForTool("learn_get"), ...oauthToolSecurity() } as any,
    async (args) => instrumentTool(env, user, "learn_get", args, async () => { const call = await learningCall(env, user, "/get", args); return { value: toolResult(call), ok: call.ok, statusCode: call.statusCode }; }));

  server.registerTool("learn_put", { description: LEARN_BASELINE_CONTEXT + " Store or materially update one compact structured memory only when Chat decides durable learning is warranted. Never write memory merely because an ordinary MCP tool ran. Project-scoped project_context is automatically canonicalized/compacted; prefer narrower Learn kinds for feature-specific behavior. This is adaptive memory, not model training.", inputSchema: { key: z.string().min(1).max(160), kind: learnKindSchema, scope: z.enum(["global", "project", "agent"]), scopeKey: z.string().min(1).max(200).optional(), content: z.string().min(1).max(4000), confidence: z.number().int().min(0).max(100).optional() }, annotations: annotationsForTool("learn_put", { destructiveHint: false }), ...oauthToolSecurity() } as any,
    async (args) => instrumentTool(env, user, "learn_put", args, async () => {
      const { call, learnChange } = await learningMutationCall(env, user, "/put", args);
      return { value: toolResult(call), ok: call.ok, statusCode: call.statusCode, learnChange };
    }));

  server.registerTool("learn_delete", { description: "Remove a learned memory when it is no longer valid or useful.", inputSchema: { id: z.string().min(1).max(400) }, annotations: annotationsForTool("learn_delete"), ...oauthToolSecurity() } as any,
    async (args) => instrumentTool(env, user, "learn_delete", args, async () => {
      const { call, learnChange } = await learningMutationCall(env, user, "/delete", args);
      return { value: toolResult(call), ok: call.ok, statusCode: call.statusCode, learnChange };
    }));

  server.registerTool("learn_feedback", { description: "Reinforce or weaken one learned memory for this authenticated account.", inputSchema: { id: z.string().min(1).max(400), value: z.enum(["positive", "negative"]) }, annotations: annotationsForTool("learn_feedback", { destructiveHint: false }), ...oauthToolSecurity() } as any,
    async (args) => instrumentTool(env, user, "learn_feedback", args, async () => {
      const { call, learnChange } = await learningMutationCall(env, user, "/feedback", args);
      return { value: toolResult(call), ok: call.ok, statusCode: call.statusCode, learnChange };
    }));

  server.registerTool(
    "ping_agent",
    {
      description: "Check whether a permitted local agent is reachable.",
      inputSchema: { agentId: agentIdSchema },
      annotations: annotationsForTool("ping_agent"),
      ...oauthToolSecurity(),
    } as any,
    async ({ agentId }) => instrumentTool(env, user, "ping_agent", { agentId }, async () => {
      const call = await callAgent(env, user, "read", agentId, { action: "ping" });
      return { value: toolResult(call), ok: call.ok, agentId: call.agentId };
    }),
  );

  const register = (
    name: string,
    description: string,
    scope: Scope,
    inputSchema: Record<string, any>,
    payload: (args: any) => unknown,
    annotations?: Record<string, boolean>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: { agentId: agentIdSchema, ...inputSchema },
        annotations: annotationsForTool(name, annotations),
      ...oauthToolSecurity(),
      } as any,
      async (args: any) => instrumentTool(env, user, name, args, async () => {
        const agentPayload = payload(args) as any;
        const activity = toolActivityContexts.get(user);
        if (agentPayload && ["terminal.start", "terminal.shell.start", "terminal.batch.start"].includes(agentPayload.action)) {
          agentPayload.observability = {
            userId: user.id,
            ...(activity?.activityId ? { activityId: activity.activityId } : {}),
            ...(activity?.toolCallId ? { toolCallId: activity.toolCallId } : {}),
          };
        }
        const call = await callAgent(env, user, scope, args.agentId, agentPayload);
        return {
          value: toolResult(call),
          ok: call.ok,
          agentId: call.agentId,
          statusCode: call.statusCode,
          ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }),
          ...(call.timing ? { timing: call.timing } : {}),
          ...failureMetadata(call),
        };
      }),
    );
  };

  register("get_config", "Get local agent and machine configuration.", "read", {}, () => ({
    action: "agent.config",
  }));

  register(
    "get_recent_tool_calls",
    "Get recent calls handled by the local agent.",
    "read",
    { limit: z.number().int().min(1).max(100).optional() },
    ({ limit }) => ({ action: "agent.recentCalls", limit }),
  );

  register(
    "agent_lifecycle_status",
    "Get local agent drain, restart, upgrade, and active-work state.",
    "read",
    {},
    () => ({ action: "agent.lifecycle.status" }),
  );

  register(
    "drain_agent",
    "Stop admitting new work while allowing current work to finish before restart or upgrade.",
    "process",
    {},
    () => ({ action: "agent.lifecycle.drain" }),
  );

  register(
    "resume_agent",
    "Cancel drain mode and resume normal local agent work admission.",
    "process",
    {},
    () => ({ action: "agent.lifecycle.resume" }),
  );

  register(
    "restart_agent",
    "Restart the local agent after it is drained and no active work remains.",
    "process",
    {},
    () => ({ action: "agent.lifecycle.restart" }),
  );

  register(
    "upgrade_agent",
    "Hand off the drained local agent to @anusornneal/chat-relay@latest and reconnect with saved configuration. Requires no active work.",
    "process",
    {},
    () => ({ action: "agent.lifecycle.upgrade" }),
  );

  register(
    "stat_path",
    "Get metadata for a file or directory.",
    "read",
    { path: z.string().min(1).max(2048) },
    ({ path }) => ({ action: "fs.stat", path }),
  );

  register(
    "list_directory",
    "List a directory with bounded pagination. Depth is limited to 0-3; use nextOffset to continue.",
    "read",
    {
      path: z.string().min(1).max(2048),
      depth: z.number().int().min(0).max(3).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      maxBytes: z.number().int().min(4096).max(49152).optional(),
    },
    ({ path, depth, offset, limit, maxBytes }) => ({ action: "fs.list", path, depth, offset, limit, maxBytes }),
  );

  register(
    "read_file",
    "Read a UTF-8 text file by line offset/count with a bounded response and deterministic nextOffset.",
    "read",
    {
      path: z.string().min(1).max(2048),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(1000).optional(),
      maxBytes: z.number().int().min(1024).max(49152).optional(),
    },
    ({ path, offset, length, maxBytes }) => ({
      action: "fs.read", path, offset, length, maxBytes,
    }),
  );

  register(
    "read_multiple_files",
    "Read up to 20 UTF-8 text files with one aggregate response budget. String paths remain supported; object entries can set offset, length, and maxBytes.",
    "read",
    {
      paths: z.array(z.union([
        z.string().min(1).max(2048),
        z.object({
          path: z.string().min(1).max(2048),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).max(1000).optional(),
          maxBytes: z.number().int().min(1024).max(49152).optional(),
        }),
      ])).min(1).max(20),
      maxTotalBytes: z.number().int().min(4096).max(49152).optional(),
    },
    ({ paths, maxTotalBytes }) => ({ action: "fs.readMany", paths, maxTotalBytes }),
  );


  register(
    "fs_batch",
    "Run up to 20 bounded read-only filesystem stat/read/list operations in one relay round trip. Per-item failures are isolated; use nextIndex and nested continuation fields when results are truncated.",
    "read",
    {
      operations: z.array(z.object({
        id: z.string().min(1).max(128).optional(),
        op: z.enum(["stat", "read", "list"]),
        path: z.string().min(1).max(2048),
        depth: z.number().int().min(0).max(3).optional(),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        maxBytes: z.number().int().min(1024).max(49152).optional(),
      })).min(1).max(20),
      maxTotalBytes: z.number().int().min(4096).max(49152).optional(),
    },
    ({ operations, maxTotalBytes }) => ({ action: "fs.batch", operations, maxTotalBytes }),
  );

  register(
    "start_search",
    "Search file names or text content under an allowed path. Returns a search session ID.",
    "read",
    {
      path: z.string().min(1).max(2048),
      pattern: z.string().min(1).max(300),
      searchType: z.enum(["files", "content"]).optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
    },
    ({ path, pattern, searchType, maxResults }) => ({
      action: "fs.search.start", path, pattern, searchType, maxResults,
    }),
  );

  register(
    "get_more_search_results",
    "Read a page of results from a search session.",
    "read",
    {
      sessionId: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(100).optional(),
    },
    ({ sessionId, offset, length }) => ({
      action: "fs.search.results", sessionId, offset, length,
    }),
  );

  register(
    "write_file",
    "Write or append UTF-8 text to a file.",
    "write",
    {
      path: z.string().min(1).max(2048),
      content: z.string().max(262144),
      mode: z.enum(["rewrite", "append"]).optional(),
    },
    ({ path, content, mode }) => ({ action: "fs.write", path, content, mode }),
    { destructiveHint: true },
  );

  register(
    "edit_block",
    "Replace an exact text block in a UTF-8 file.",
    "write",
    {
      path: z.string().min(1).max(2048),
      oldText: z.string().min(1).max(131072),
      newText: z.string().max(131072),
      expectedReplacements: z.number().int().min(1).max(100).optional(),
    },
    ({ path, oldText, newText, expectedReplacements }) => ({
      action: "fs.edit", path, oldText, newText, expectedReplacements,
    }),
    { destructiveHint: true },
  );

  register(
    "create_directory",
    "Create a directory recursively.",
    "write",
    { path: z.string().min(1).max(2048) },
    ({ path }) => ({ action: "fs.mkdir", path }),
  );

  register(
    "move_path",
    "Move or rename a file or directory.",
    "write",
    {
      source: z.string().min(1).max(2048),
      destination: z.string().min(1).max(2048),
    },
    ({ source, destination }) => ({ action: "fs.move", source, destination }),
    { destructiveHint: true },
  );

  register(
    "delete_path",
    "Delete a file or directory. Set recursive=true for non-empty directories.",
    "write",
    {
      path: z.string().min(1).max(2048),
      recursive: z.boolean().optional(),
    },
    ({ path, recursive }) => ({ action: "fs.delete", path, recursive }),
    { destructiveHint: true },
  );

  register(
    "cleanup_worktree",
    "Safely remove a completed Git worktree and delete its merged local branch. Refuses dirty, unmerged, protected, detached, unregistered, primary, or out-of-root targets.",
    "write",
    {
      repoPath: z.string().min(1).max(2048),
      worktreePath: z.string().min(1).max(2048),
    },
    ({ repoPath, worktreePath }) => ({ action: "git.worktree.cleanup", repoPath, worktreePath }),
    { destructiveHint: true },
  );

  register(
    "list_processes",
    "List Windows processes with PID, name, command line, and executable path.",
    "process",
    { filter: z.string().max(200).optional() },
    ({ filter }) => ({ action: "process.list", filter }),
  );

  register(
    "kill_process",
    "Forcefully terminate a process tree by PID.",
    "process",
    { pid: z.number().int().min(101) },
    ({ pid }) => ({ action: "process.kill", pid }),
    { destructiveHint: true },
  );


  server.registerTool(
    "create_temp_artifact",
    {
      description: "Create a short-lived URL for one explicit local file inside the agent's allowed roots. The file is bounded to 40 KiB and the URL expires after 5 minutes by default.",
      inputSchema: {
        agentId: agentIdSchema,
        path: z.string().min(1).max(2048),
        maxBytes: z.number().int().min(1024).max(40960).optional(),
        ttlSeconds: z.number().int().min(1).max(900).optional(),
      },
      annotations: annotationsForTool("create_temp_artifact"),
      ...oauthToolSecurity(),
    } as any,
    async ({ agentId, path, maxBytes, ttlSeconds }: any) =>
      instrumentTool(env, user, "create_temp_artifact", { agentId, path, maxBytes, ttlSeconds }, async () => {
        const call = await callAgent(env, user, "read", agentId, {
          action: "fs.artifact",
          path,
          maxBytes,
        });
        return {
          value: await tempArtifactToolResult(env, call.agentId, call, ttlSeconds),
          ok: call.ok,
          agentId: call.agentId,
          ...failureMetadata(call),
        };
      }),
  );

  server.registerTool(
    "screenshot",
    {
      description: "Capture a full monitor and return a temporary JPEG URL valid for 5 minutes. monitor can be primary, secondary, or a zero-based monitor index. Set native=true to preserve native pixel dimensions; otherwise maxWidth controls the bounded preview size. Requires local desktop opt-in and desktop_read permission.",
      inputSchema: {
        agentId: agentIdSchema,
        monitor: z.union([z.enum(["primary", "secondary"]), z.number().int().min(0).max(15)]).optional(),
        maxWidth: z.number().int().min(320).max(1920).optional(),
        quality: z.number().int().min(20).max(85).optional(),
        native: z.boolean().optional(),
      },
      annotations: annotationsForTool("screenshot"),
      ...oauthToolSecurity(),
    } as any,
    async ({ agentId, monitor, maxWidth, quality, native }: any) => instrumentTool(env, user, "screenshot", { agentId, monitor, maxWidth, quality, native }, async () => {
      const call = await callAgent(env, user, "desktop_read", agentId, { action: "desktop.screenshot", monitor, maxWidth, quality, native });
      return {
        value: await screenshotToolResult(env, call.agentId, call),
        ok: call.ok,
        agentId: call.agentId,
        ...(call.timing ? { timing: call.timing } : {}),
        ...failureMetadata(call),
      };
    }),
  );

  register(
    "clipboard_read",
    "Read up to 8192 characters from the Windows clipboard. Requires desktop_read permission.",
    "desktop_read",
    {},
    () => ({ action: "desktop.clipboard.read" }),
  );

  register(
    "clipboard_write",
    "Replace the Windows clipboard text. Requires desktop_control permission.",
    "desktop_control",
    { text: z.string().max(8192) },
    ({ text }) => ({ action: "desktop.clipboard.write", text }),
    { destructiveHint: true },
  );

  register(
    "list_windows",
    "List visible top-level Windows application windows with stable window ids and desktop bounds.",
    "desktop_read",
    { limit: z.number().int().min(1).max(100).optional() },
    ({ limit }) => ({ action: "desktop.window.list", limit }),
  );

  register(
    "focus_window",
    "Restore and focus one visible Windows window by window id. Requires desktop_control permission.",
    "desktop_control",
    { windowId: z.string().regex(/^[1-9][0-9]{0,19}$/) },
    ({ windowId }) => ({ action: "desktop.window.focus", windowId }),
    { destructiveHint: true },
  );

  register(
    "mouse_click",
    "Click a primary-desktop coordinate on the connected Windows PC. Coordinates use the desktop space described by screenshot metadata.",
    "desktop_control",
    {
      x: z.number().int().min(-32768).max(32767),
      y: z.number().int().min(-32768).max(32767),
      button: z.enum(["left", "right", "middle"]).optional(),
      clicks: z.union([z.literal(1), z.literal(2)]).optional(),
    },
    ({ x, y, button, clicks }) => ({ action: "desktop.mouse.click", x, y, button, clicks }),
    { destructiveHint: true },
  );

  register(
    "keyboard_input",
    "Type Unicode text or send one named key/modifier chord to the active Windows desktop. Supply text or key, not both.",
    "desktop_control",
    {
      text: z.string().min(1).max(8192).optional(),
      key: z.enum([
        "Enter", "Tab", "Escape", "Backspace", "Delete",
        "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
        "Home", "End", "PageUp", "PageDown", "Space",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
      ]).optional(),
      ctrl: z.boolean().optional(),
      alt: z.boolean().optional(),
      shift: z.boolean().optional(),
      win: z.boolean().optional(),
    },
    ({ text, key, ctrl, alt, shift, win }) => ({ action: "desktop.keyboard.input", text, key, ctrl, alt, shift, win }),
    { destructiveHint: true },
  );

  server.registerTool(
    "desktop_step",
    {
      description: "Run 1-20 desktop actions in one local round trip and optionally capture the target monitor afterward. Use this for fast computer-use loops. captureAfter defaults to false; set captureAfter=true when you need a screenshot afterward. Capturing requires both desktop_control and desktop_read permission.",
      inputSchema: {
        agentId: agentIdSchema,
        actions: z.array(z.union([
          z.object({
            type: z.literal("click"),
            x: z.number().int().min(-32768).max(32767),
            y: z.number().int().min(-32768).max(32767),
            button: z.enum(["left", "right", "middle"]).optional(),
            clicks: z.union([z.literal(1), z.literal(2)]).optional(),
          }),
          z.object({
            type: z.literal("text"),
            text: z.string().min(1).max(8192),
          }),
          z.object({
            type: z.literal("key"),
            key: z.enum([
              "Enter", "Tab", "Escape", "Backspace", "Delete",
              "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
              "Home", "End", "PageUp", "PageDown", "Space",
              "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
              "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
              "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
              "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            ]),
            ctrl: z.boolean().optional(),
            alt: z.boolean().optional(),
            shift: z.boolean().optional(),
            win: z.boolean().optional(),
          }),
          z.object({
            type: z.literal("wait"),
            ms: z.number().int().min(0).max(5000),
          }),
        ])).min(1).max(20),
        captureAfter: z.boolean().optional(),
        settleMs: z.number().int().min(0).max(5000).optional(),
        monitor: z.union([z.enum(["primary", "secondary"]), z.number().int().min(0).max(15)]).optional(),
        maxWidth: z.number().int().min(320).max(1920).optional(),
        quality: z.number().int().min(20).max(85).optional(),
      },
      annotations: annotationsForTool("desktop_step", { destructiveHint: true }),
      ...oauthToolSecurity(),
    } as any,
    async ({ agentId, actions, captureAfter, settleMs, monitor, maxWidth, quality }: any) => instrumentTool(
      env,
      user,
      "desktop_step",
      { agentId, actions, captureAfter, settleMs, monitor, maxWidth, quality },
      async () => {
        const wantsCapture = captureAfter === true;
        const call = await callAgent(
          env,
          user,
          wantsCapture ? ["desktop_control", "desktop_read"] : "desktop_control",
          agentId,
          { action: "desktop.step", actions, captureAfter, settleMs, monitor, maxWidth, quality },
        );
        return {
          value: wantsCapture ? await screenshotToolResult(env, call.agentId, call) : toolResult(call),
          ok: call.ok,
          agentId: call.agentId,
          ...(call.timing ? { timing: call.timing } : {}),
          ...failureMetadata(call),
        };
      },
    ),
  );

  register(
    "terminal_exec",
    "Run one PowerShell command and wait for completion. Use for commands that finish within 20 seconds.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
      timeoutMs: z.number().int().min(1000).max(20000).optional(),
    },
    ({ command, cwd, timeoutMs }) => ({ action: "terminal.exec", command, cwd, timeoutMs }),
    { destructiveHint: true },
  );

  register(
    "terminal_batch_start",
    "Start 2-20 PowerShell jobs in one MCP call with bounded per-agent concurrency and queue backpressure.",
    "terminal",
    {
      jobs: z.array(z.union([
        z.string().min(1).max(4000),
        z.object({ command: z.string().min(1).max(4000), cwd: z.string().min(1).max(2048).optional(), timeoutMs: z.number().int().min(1000).max(20000).optional() }),
      ])).min(2).max(20),
      cwd: z.string().min(1).max(2048).optional(),
      timeoutMs: z.number().int().min(1000).max(20000).optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
    },
    ({ jobs, cwd, timeoutMs, concurrency }) => ({ action: "terminal.batch.start", jobs, cwd, timeoutMs, concurrency }),
    { destructiveHint: true },
  );

  register(
    "terminal_batch_status",
    "Read bounded status for a terminal batch without command output.",
    "terminal",
    { batchId: z.string().uuid() },
    ({ batchId }) => ({ action: "terminal.batch.status", batchId }),
  );

  register(
    "terminal_batch_read",
    "Read bounded stdout/stderr and status for a terminal batch.",
    "terminal",
    { batchId: z.string().uuid(), maxChars: z.number().int().min(1024).max(24576).optional() },
    ({ batchId, maxChars }) => ({ action: "terminal.batch.read", batchId, maxChars }),
  );

  register(
    "terminal_batch_cancel",
    "Cancel queued and running jobs in a terminal batch.",
    "terminal",
    { batchId: z.string().uuid() },
    ({ batchId }) => ({ action: "terminal.batch.cancel", batchId }),
    { destructiveHint: true },
  );

  register(
    "terminal_start",
    "Start a long-running PowerShell command and return a terminal session ID immediately.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
    },
    ({ command, cwd }) => ({ action: "terminal.start", command, cwd }),
    { destructiveHint: true },
  );

  register(
    "terminal_start_shell",
    "Start a persistent interactive PowerShell session.",
    "terminal",
    { cwd: z.string().min(1).max(2048).optional() },
    ({ cwd }) => ({ action: "terminal.shell.start", cwd }),
    { destructiveHint: true },
  );

  register(
    "terminal_read",
    "Read buffered stdout/stderr from a terminal session. Use afterSeq for incremental reads.",
    "terminal",
    {
      sessionId: terminalSessionIdSchema,
      afterSeq: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1024).max(24576).optional(),
    },
    ({ sessionId, afterSeq, maxChars }) => ({
      action: "terminal.read", sessionId, afterSeq, maxChars,
    }),
  );

  register(
    "terminal_write",
    "Send input to a running command or interactive shell.",
    "terminal",
    {
      sessionId: terminalSessionIdSchema,
      input: z.string().min(1).max(8192),
      appendNewline: z.boolean().optional(),
    },
    ({ sessionId, input, appendNewline }) => ({
      action: "terminal.write", sessionId, input, appendNewline,
    }),
    { destructiveHint: true },
  );

  register(
    "terminal_list",
    "List running and recently completed terminal sessions.",
    "terminal",
    {},
    () => ({ action: "terminal.list" }),
  );

  register(
    "terminal_kill",
    "Terminate a terminal session and its child process tree.",
    "terminal",
    { sessionId: terminalSessionIdSchema },
    ({ sessionId }) => ({ action: "terminal.kill", sessionId }),
    { destructiveHint: true },
  );

  register(
    "start_process",
    "Desktop-Commander-compatible alias for starting a long-running command.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
    },
    ({ command, cwd }) => ({ action: "terminal.start", command, cwd }),
    { destructiveHint: true },
  );

  register(
    "read_process_output",
    "Desktop-Commander-compatible alias for reading session output.",
    "terminal",
    {
      sessionId: terminalSessionIdSchema,
      afterSeq: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1024).max(24576).optional(),
    },
    ({ sessionId, afterSeq, maxChars }) => ({
      action: "terminal.read", sessionId, afterSeq, maxChars,
    }),
  );

  register(
    "interact_with_process",
    "Desktop-Commander-compatible alias for sending input to a terminal session.",
    "terminal",
    {
      sessionId: terminalSessionIdSchema,
      input: z.string().min(1).max(8192),
      appendNewline: z.boolean().optional(),
    },
    ({ sessionId, input, appendNewline }) => ({
      action: "terminal.write", sessionId, input, appendNewline,
    }),
    { destructiveHint: true },
  );

  register(
    "list_sessions",
    "Desktop-Commander-compatible alias for listing terminal sessions.",
    "terminal",
    {},
    () => ({ action: "terminal.list" }),
  );

  register(
    "force_terminate",
    "Desktop-Commander-compatible alias for terminating a terminal session.",
    "terminal",
    { sessionId: terminalSessionIdSchema },
    ({ sessionId }) => ({ action: "terminal.kill", sessionId }),
    { destructiveHint: true },
  );

  return server;
}

async function handleDirectRelay(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") || undefined;
  let body: unknown;
  try { body = await readJson(request); }
  catch (cause) {
    const code = cause instanceof Error && cause.message === "payload_too_large"
      ? "payload_too_large" : "invalid_json";
    return error(code === "payload_too_large" ? 413 : 400, code);
  }
  if (!hasPayload(body)) return error(400, "payload_required");

  const action = typeof body.payload === "object" && body.payload !== null
    ? String((body.payload as any).action ?? "")
    : "";
  const requestedScopes: Scope[] = action === "desktop.step" && (body.payload as any)?.captureAfter === true
    ? ["desktop_control", "desktop_read"]
    : [scopeForAction(action)];
  const resolved = await resolveAgentForScopes(env, user.id, requestedScopes, agentId);
  if (!resolved.ok) return resolved.response;

  const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
  return stub.fetch(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/tmp-shot/")) {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const parts = path.split("/").filter(Boolean);
      if (parts.length !== 3) return error(404, "not_found");

      const agentId = decodeURIComponent(parts[1]);
      const token = parts[2];
      if (!/^[a-z0-9_-]{1,64}$/.test(agentId) || !/^[a-f0-9]{32}$/.test(token)) {
        return error(404, "not_found");
      }

      const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
      return stub.fetch("https://relay.internal/temp-shot/" + token);
    }
    if (path.startsWith("/tmp-artifact/")) {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const parts = path.split("/").filter(Boolean);
      if (parts.length !== 3) return error(404, "not_found");

      const agentId = decodeURIComponent(parts[1]);
      const token = parts[2];
      if (!/^[a-z0-9_-]{1,64}$/.test(agentId) || !/^[a-f0-9]{32}$/.test(token)) {
        return error(404, "not_found");
      }

      const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
      return stub.fetch("https://relay.internal/temp-artifact/" + token);
    }



    if ((path === "/" || path === "/admin") && env.ASSETS) {
      return Response.redirect(url.origin + "/dashboard/", 302);
    }
    if (path === "/dashboard" && env.ASSETS) {
      return Response.redirect(url.origin + "/dashboard/", 302);
    }
    if (path.startsWith("/dashboard/") && env.ASSETS) {
      const assetPath = path.slice("/dashboard".length) || "/index.html";
      const resolvedPath = assetPath === "/" ? "/" : assetPath;
      return env.ASSETS.fetch(new Request(url.origin + resolvedPath, request));
    }

    if (path === "/health") {
      return request.method === "GET"
        ? Response.json({
          status: "ok",
          service: "chat-relay",
          version: SERVICE_VERSION,
          optionalUsageBudget: usageRecordBudget.snapshot(env.USAGE_RECORD_DAILY_BUDGET),
          usageBatch: {
            pending: usageEventBuffer.length,
            maxEvents: USAGE_BATCH_MAX_EVENTS,
            delayMs: USAGE_BATCH_DELAY_MS,
          },
        })
        : error(405, "method_not_allowed");
    }

    if (path === "/.well-known/openai-apps-challenge") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const token = String(env.OPENAI_APPS_CHALLENGE || "").trim();
      if (!token) return error(404, "not_found");
      return new Response(token, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const oauthSessionUser = path === "/authorize" && request.method === "GET"
      ? await browserSessionUser(request, env)
      : null;
    const oauthTelemetryRequest = path === "/token" && request.method === "POST"
      ? request.clone()
      : null;
    const oauthAuthorizeTelemetryRequest = request.method === "GET" &&
      (path === "/authorize" || path === "/authorize/google/start")
      ? request.clone()
      : null;
    const oauthResponse = await handleOAuth(
      request,
      (registryPath, body) => registryCall(env, registryPath, body),
      env,
      oauthSessionUser,
    );
    if (oauthResponse) {
      if (oauthAuthorizeTelemetryRequest) {
        const action = path === "/authorize"
          ? "connector.oauth.authorize.response"
          : "connector.oauth.google_start.response";
        ctx.waitUntil(recordConnectorAuthEvent(
          env,
          action,
          oauthResponse.status < 400 ? "success" : "failure",
          connectorAuthorizeTelemetry(
            oauthAuthorizeTelemetryRequest,
            oauthResponse,
            Boolean(oauthSessionUser?.id),
          ),
        ));
      }
      if (oauthTelemetryRequest && !oauthResponse.ok) {
        ctx.waitUntil(recordOAuthTokenFailure(
          env,
          oauthTelemetryRequest,
          oauthResponse.clone(),
        ));
      }
      return oauthResponse;
    }

    const authResponse = await handleDeviceAuth(
      request,
      (registryPath, body) => registryCall(env, registryPath, body),
      (authRequest) => authenticateUser(authRequest, env),
      env,
    );
    if (authResponse) return authResponse;

    if (path.startsWith("/admin/")) {
      if (request.method === "GET" && ["/admin/api/overview", "/admin/api/summary"].includes(path)) {
        await flushPendingUsage(env);
      }
      const response = await handleAdmin(request, env);
      if (response.ok && request.method !== "GET" && ADMIN_SECURITY_MUTATION_PATHS.has(path)) {
        invalidateLocalSecurityCaches();
      }
      return response;
    }

    if (path === "/agent") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const agentId = url.searchParams.get("agentId");
      if (!agentId) return error(400, "agent_id_required");
      if (!(await authenticateAgent(request, env, agentId))) return error(401, "unauthorized");

      const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
      return stub.fetch(request);
    }

    if (path === "/mcp") {
      const authResult = await authenticateUserResult(request, env);
      const authenticatedUser = authResult.user;
      if (!authenticatedUser) {
        if (bearerToken(request)) {
          ctx.waitUntil(recordConnectorAuthFailure(env, "connector.mcp.auth.failure", {
            status: authResult.response?.status ?? 401,
            reason: authResult.reason ?? "unauthorized",
          }));
        }
        return Response.json(
          { error: "unauthorized" },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": oauthChallenge(url.origin),
              "cache-control": "no-store",
            },
          },
        );
      }

      const user: AuthUser = { ...authenticatedUser };
      toolActivityContexts.set(user, {
        ...(await activityContextForRequest(request)),
        executionCtx: ctx,
      });
      return createMcpHandler(() => createMcpServer(env, user), {
        route: "/mcp",
        responseMode: "json",
      })(request, env, ctx);
    }

    if (path === "/status") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      return handleStatusRequest({
        request,
        expectedProtocolVersion: AGENT_PROTOCOL_VERSION,
        authenticate: () => authenticateUserResult(request, env),
        resolveAgent: (userId) => resolveAgent(env, userId, "read"),
        getAgentAccess: (userId, agentId) => registryJson(env, "/agent-access", {
          userId,
          agentId,
        }),
        getRelayStatus: (agentId) => env.RELAY.get(env.RELAY.idFromName(agentId))
          .fetch("https://relay.internal/status"),
        features: { learn: true },
      });
    }
    if (path === "/relay") {
      if (request.method !== "POST") return error(405, "method_not_allowed");
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        return error(415, "json_required");
      }
      const user = await authenticateUser(request, env);
      if (!user) return error(401, "unauthorized");
      return handleDirectRelay(request, env, user);
    }

    return error(404, "not_found");
  },
};
