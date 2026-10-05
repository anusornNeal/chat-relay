export type GoogleAuthEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  PUBLIC_BASE_URL?: string;
};

export type GoogleIdentity = { sub: string; email: string; name: string };

const GOOGLE_STATE_COOKIE = "chat_relay_google_oauth";
const GOOGLE_STATE_TTL_SECONDS = 10 * 60;

function cookieValue(request: Request, name: string) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function stateCookie(value: string, maxAge = GOOGLE_STATE_TTL_SECONDS) {
  return GOOGLE_STATE_COOKIE + "=" + encodeURIComponent(value) +
    "; Path=/admin/google; Max-Age=" + maxAge +
    "; HttpOnly; Secure; SameSite=Lax";
}

export function clearGoogleStateCookie() { return stateCookie("", 0); }

function redirectUri(request: Request, env: GoogleAuthEnv) {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  const base = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  return base + "/admin/google/callback";
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64Url(values);
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function googleStateKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signedGoogleState(
  secret: string,
  payload: { state: string; nonce: string; verifier: string; continuation?: string },
) {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await googleStateKey(secret),
    new TextEncoder().encode(encoded),
  );
  return encoded + "." + base64Url(new Uint8Array(signature));
}

async function readSignedGoogleState(secret: string, value: string) {
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await googleStateKey(secret),
      base64UrlDecode(signature),
      new TextEncoder().encode(encoded),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
    if (!payload || typeof payload !== "object") return null;
    return payload as { state?: unknown; nonce?: unknown; verifier?: unknown; continuation?: unknown };
  } catch {
    return null;
  }
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1] || "";
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] || char)
  );
}

function connectorRecoveryHref(continuation: string) {
  if (!continuation) return "";
  try {
    const payload = JSON.parse(continuation);
    const params = payload?.kind === "connector-oauth" ? payload.params : null;
    if (!params ||
        typeof params.clientId !== "string" ||
        typeof params.redirectUri !== "string" ||
        typeof params.responseType !== "string" ||
        typeof params.codeChallenge !== "string" ||
        typeof params.codeChallengeMethod !== "string" ||
        typeof params.scopeRaw !== "string" ||
        typeof params.resource !== "string" ||
        typeof params.state !== "string") {
      return "";
    }
    const query = new URLSearchParams({
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      response_type: params.responseType,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      scope: params.scopeRaw,
      resource: params.resource,
      state: params.state,
      recovery: "1",
    });
    return "/authorize?" + query.toString();
  } catch {
    return "";
  }
}

function googleError(message: string, status = 400, recoveryHref = "") {
  const recovery = recoveryHref
    ? '<p><a href="' + escapeHtml(recoveryHref) + '">Use owner recovery in this browser</a></p>'
    : "";
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Google sign-in failed</title>' +
      '<main style="font-family:system-ui;max-width:520px;margin:80px auto;padding:24px">' +
      "<h1>Google sign-in failed</h1><p>" + escapeHtml(message) +
      "</p>" + recovery + '<p><a href="/dashboard/">Back to dashboard</a></p></main>',
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": clearGoogleStateCookie(),
      },
    },
  );
}

export async function startGoogleLogin(request: Request, env: GoogleAuthEnv, continuation = "", options: { selectAccount?: boolean } = {}): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return googleError("Google login is not configured.", 503);
  }

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri(request, env));
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("code_challenge", challenge);
  target.searchParams.set("code_challenge_method", "S256");
  if (options.selectAccount !== false) target.searchParams.set("prompt", "select_account");

  const cookieState = await signedGoogleState(env.GOOGLE_CLIENT_SECRET, {
    state,
    nonce,
    verifier,
    ...(continuation ? { continuation } : {}),
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "set-cookie": stateCookie(cookieState),
    },
  });
}

export async function finishGoogleLogin(
  request: Request,
  env: GoogleAuthEnv,
): Promise<{ ok: true; identity: GoogleIdentity; continuation?: string } | { ok: false; response: Response }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, response: googleError("Google login is not configured.", 503) };
  }

  const url = new URL(request.url);
  const returnedState = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  const statePayload = await readSignedGoogleState(
    env.GOOGLE_CLIENT_SECRET,
    cookieValue(request, GOOGLE_STATE_COOKIE),
  );
  const state = typeof statePayload?.state === "string" ? statePayload.state : "";
  const nonce = typeof statePayload?.nonce === "string" ? statePayload.nonce : "";
  const verifier = typeof statePayload?.verifier === "string" ? statePayload.verifier : "";
  const continuation = typeof statePayload?.continuation === "string" ? statePayload.continuation : "";

  const recoveryHref = connectorRecoveryHref(continuation);
  if (providerError) {
    if (!state || !returnedState || returnedState !== state) {
      return { ok: false, response: googleError("Google sign-in state is invalid or expired.") };
    }
    return { ok: false, response: googleError("Google denied the authorization request.", 400, recoveryHref) };
  }
  if (!state || !nonce || !verifier || !returnedState || returnedState !== state || !code) {
    return { ok: false, response: googleError("Google sign-in state is invalid or expired.") };
  }

  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(request, env),
  });
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const tokenData = await tokenResponse.json<any>().catch(() => ({}));
  const idToken = String(tokenData.id_token || "");
  if (!tokenResponse.ok || !idToken) {
    return { ok: false, response: googleError("Google token exchange failed.", 502, recoveryHref) };
  }

  const tokenInfoResponse = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { headers: { "cache-control": "no-store" } },
  );
  const tokenInfo = await tokenInfoResponse.json<any>().catch(() => ({}));
  const payload = decodeJwtPayload(idToken);
  const issuer = String(tokenInfo.iss || payload?.iss || "");
  const audience = String(tokenInfo.aud || payload?.aud || "");
  const subject = String(tokenInfo.sub || payload?.sub || "");
  const email = String(tokenInfo.email || payload?.email || "").trim().toLowerCase();
  const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === "true" ||
    payload?.email_verified === true;
  const tokenNonce = String(payload?.nonce || tokenInfo.nonce || "");
  const expiresAt = Number(tokenInfo.exp || payload?.exp || 0);

  if (!tokenInfoResponse.ok ||
      !["accounts.google.com", "https://accounts.google.com"].includes(issuer) ||
      audience !== env.GOOGLE_CLIENT_ID ||
      !subject ||
      tokenNonce !== nonce ||
      !emailVerified ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !Number.isFinite(expiresAt) ||
      expiresAt * 1000 <= Date.now()) {
    return { ok: false, response: googleError("Google identity token validation failed.", 401, recoveryHref) };
  }

  const name = String(tokenInfo.name || payload?.name || email.split("@")[0] || email).slice(0, 120);
  return {
    ok: true,
    identity: { sub: subject.slice(0, 255), email, name },
    ...(continuation ? { continuation } : {}),
  };
}

export function googleLoginSuccessPage(csrfToken: string, sessionCookie: string): Response {
  const scriptValue = JSON.stringify(csrfToken);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  headers.append("set-cookie", sessionCookie);
  headers.append("set-cookie", clearGoogleStateCookie());
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
      "<script>sessionStorage.setItem('chat_relay_csrf'," + scriptValue +
      ");location.replace('/dashboard/');</script>" +
      '<p>Signed in. <a href="/dashboard/">Continue</a></p>',
    { status: 200, headers },
  );
}
