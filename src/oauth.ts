import { hashToken, newToken } from "./registry";

type RegistryCall = (path: string, body?: unknown) => Promise<Response>;

type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  createdAt: string;
};

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string[];
  scopeRaw: string;
  resource: string;
  state: string;
};

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const SUPPORTED_SCOPES = new Set(["mcp", "offline_access"]);

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function oauthError(code: string, description: string, status = 400): Response {
  return noStoreJson({ error: code, error_description: description }, status);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseScope(value: string): string[] | null {
  const requested = value.trim() ? value.trim().split(/\s+/) : ["mcp"];
  const unique = [...new Set(requested)];
  if (!unique.includes("mcp")) unique.unshift("mcp");
  if (unique.some((scope) => !SUPPORTED_SCOPES.has(scope))) return null;
  return unique;
}

async function sourceHash(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "local";
  return hashToken(source);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function resourceUrl(url: URL): string {
  return `${url.origin}/mcp`;
}

async function getClient(
  registryCall: RegistryCall,
  clientId: string,
): Promise<OAuthClient | null> {
  const response = await registryCall("/oauth/client/get", { clientId });
  if (!response.ok) return null;
  const data = await response.json() as { client?: OAuthClient };
  return data.client ?? null;
}

async function validateAuthorize(
  values: { get(name: string): unknown },
  url: URL,
  registryCall: RegistryCall,
): Promise<{ params: AuthorizeParams; client: OAuthClient } | Response> {
  const stringValue = (name: string) => String(values.get(name) ?? "");
  const clientId = stringValue("client_id");
  const redirectUri = stringValue("redirect_uri");
  const responseType = stringValue("response_type");
  const codeChallenge = stringValue("code_challenge");
  const codeChallengeMethod = stringValue("code_challenge_method");
  const scopeRaw = stringValue("scope");
  const resource = stringValue("resource");
  const state = stringValue("state");

  const client = await getClient(registryCall, clientId);
  if (!client) return oauthError("invalid_client", "Unknown OAuth client.");
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri is not registered.");
  }
  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported.");
  }

  if (codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return oauthError("invalid_request", "PKCE S256 is required.");
  }

  const scope = parseScope(scopeRaw);
  if (!scope) return oauthError("invalid_scope", "Unsupported OAuth scope.");
  if (resource !== resourceUrl(url)) {
    return oauthError("invalid_target", "resource must match the MCP endpoint.");
  }
  if (state.length > 2048) {
    return oauthError("invalid_request", "state is too long.");
  }

  return {
    client,
    params: {
      clientId,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
      scope,
      scopeRaw: scope.join(" "),
      resource,
      state,
    },
  };
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f6f7f9}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(460px,100%);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.08)}
h1{font-size:24px;margin:0 0 8px}p{color:#5f6368;line-height:1.5;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:11px 12px;font:inherit}
button{width:100%;margin-top:18px;border:0;border-radius:10px;padding:12px 14px;font:600 15px inherit;background:#111827;color:#fff;cursor:pointer}
.scope{font-size:13px;background:#f4f4f5;border-radius:10px;padding:10px 12px}.error{background:#fef2f2;color:#991b1b;border-radius:10px;padding:10px 12px;margin:12px 0}
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function authorizePage(
  client: OAuthClient,
  params: AuthorizeParams,
  errorMessage = "",
): Response {
  const hidden = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["response_type", params.responseType],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", params.codeChallengeMethod],
    ["scope", params.scopeRaw],
    ["resource", params.resource],
    ["state", params.state],
  ].map(([name, value]) =>
    `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`
  ).join("");

  const scopeText = params.scope
    .filter((scope) => scope !== "offline_access")
    .join(", ");
  const offline = params.scope.includes("offline_access")
    ? " Persistent access is requested."
    : "";

  return htmlPage(
    "Authorize Chat Relay",
    `<h1>Authorize ${htmlEscape(client.clientName)}</h1>
<p>Sign in with your Chat Relay account to connect ChatGPT to your permitted computers.</p>
<div class="scope">Access: ${htmlEscape(scopeText || "mcp")}.${htmlEscape(offline)}</div>
${errorMessage ? `<div class="error">${htmlEscape(errorMessage)}</div>` : ""}
<form method="post" action="/authorize">
${hidden}
<label for="login">Login</label>
<input id="login" name="login" required autocomplete="username" minlength="3" maxlength="64">
<label for="password">Password</label>
<input id="password" name="password" type="password" required autocomplete="current-password" minlength="8" maxlength="128">
<button type="submit">Authorize</button>
</form>`,
  );
}

function redirectWithCode(params: AuthorizeParams, code: string): Response {
  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString(), "cache-control": "no-store" },
  });
}

export async function handleOAuth(
  request: Request,
  registryCall: RegistryCall,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = url.origin;
  const resource = resourceUrl(url);

  if ((path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp") &&
      request.method === "GET") {
    return noStoreJson({
      resource,
      authorization_servers: [origin],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "Chat Relay MCP",
    });
  }

  if (path === "/.well-known/oauth-authorization-server" &&
      request.method === "GET") {
    return noStoreJson({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,

      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp", "offline_access"],
    });
  }

  if (path === "/register" && request.method === "POST") {
    const body = await request.json<any>().catch(() => null);
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.map(String)
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 20 ||
        redirectUris.some((uri: string) => !validRedirectUri(uri))) {
      return oauthError("invalid_redirect_uri", "Valid redirect_uris are required.");
    }

    const authMethod = String(body?.token_endpoint_auth_method ?? "none");
    if (authMethod !== "none") {
      return oauthError("invalid_client_metadata", "Only public PKCE clients are supported.");
    }

    const grantTypes = Array.isArray(body?.grant_types)
      ? body.grant_types.map(String)
      : ["authorization_code", "refresh_token"];
    const responseTypes = Array.isArray(body?.response_types)
      ? body.response_types.map(String)
      : ["code"];

    if (grantTypes.some((value: string) =>
      !["authorization_code", "refresh_token"].includes(value)) ||
      responseTypes.some((value: string) => value !== "code")) {
      return oauthError(
        "invalid_client_metadata",
        "Unsupported OAuth client metadata.",
      );
    }

    const clientId = newToken("client");
    const clientName = String(body?.client_name ?? "ChatGPT MCP").slice(0, 120);

    const registered = await registryCall("/oauth/client/register", {
      clientId,
      clientName,
      redirectUris,
      sourceHash: await sourceHash(request),
    });
    if (!registered.ok) {
      const data = await registered.json<any>().catch(() => ({}));
      return oauthError(
        data.error ?? "invalid_client_metadata",
        "Client registration failed.",
        registered.status,
      );
    }

    return noStoreJson({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: "none",
    }, 201);
  }

  if (path === "/authorize" && request.method === "GET") {
    const validated = await validateAuthorize(
      url.searchParams,
      url,
      registryCall,
    );
    if (validated instanceof Response) return validated;
    return authorizePage(validated.client, validated.params);
  }

  if (path === "/authorize" && request.method === "POST") {
    const form = await request.formData();
    const validated = await validateAuthorize(form, url, registryCall);
    if (validated instanceof Response) return validated;

    const login = String(form.get("login") ?? "");
    const password = String(form.get("password") ?? "");
    const authenticated = await registryCall("/oauth/password", {
      login,
      password,
    });

    const authData = await authenticated.json<any>().catch(() => ({}));
    if (!authenticated.ok || !authData.user?.id) {
      const message = authData.error === "too_many_attempts"
        ? "Too many failed attempts. Try again later."
        : "Invalid login or password.";
      return authorizePage(validated.client, validated.params, message);
    }

    const code = newToken("code");
    const stored = await registryCall("/oauth/code/create", {
      codeHash: await hashToken(code),
      clientId: validated.params.clientId,
      userId: authData.user.id,
      redirectUri: validated.params.redirectUri,
      codeChallenge: validated.params.codeChallenge,
      scope: validated.params.scope,
      resource: validated.params.resource,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
    });
    if (!stored.ok) {
      return oauthError("server_error", "Unable to create authorization code.", 500);
    }
    return redirectWithCode(validated.params, code);
  }

  if (path === "/token" && request.method === "POST") {
    const form = await request.formData();
    const grantType = String(form.get("grant_type") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const requestedResource = String(form.get("resource") ?? "");

    if (!clientId || !(await getClient(registryCall, clientId))) {
      return oauthError("invalid_client", "Unknown OAuth client.", 401);
    }
    if (requestedResource !== resource) {
      return oauthError("invalid_target", "resource must match the MCP endpoint.");
    }

    if (grantType === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const redirectUri = String(form.get("redirect_uri") ?? "");
      const verifier = String(form.get("code_verifier") ?? "");
      if (!code || !redirectUri ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return oauthError("invalid_grant", "Invalid authorization code exchange.");
      }

      const exchanged = await registryCall("/oauth/code/exchange", {
        codeHash: await hashToken(code),
        clientId,
        redirectUri,
        codeChallenge: await pkceChallenge(verifier),
        resource: requestedResource,
      });
      const data = await exchanged.json<any>().catch(() => ({
        error: "server_error",
      }));
      return noStoreJson(data, exchanged.status);
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(form.get("refresh_token") ?? "");
      if (!refreshToken) {
        return oauthError("invalid_grant", "refresh_token is required.");
      }
      const exchanged = await registryCall("/oauth/refresh/exchange", {
        refreshTokenHash: await hashToken(refreshToken),
        clientId,
        resource: requestedResource,
      });

      const data = await exchanged.json<any>().catch(() => ({
        error: "server_error",
      }));
      return noStoreJson(data, exchanged.status);
    }

    return oauthError(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported.",
    );
  }

  return null;
}

export function oauthChallenge(origin: string): string {
  const metadata = `${origin}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="mcp"`;
}

export function oauthResource(request: Request): string {
  return `${new URL(request.url).origin}/mcp`;
}
