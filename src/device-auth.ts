import { formatUserCode, randomCode } from "./auth-crypto";
import { hashToken, newToken } from "./registry";

type AuthUser = { id: string; name: string; login?: string | null };
type RegistryCall = (path: string, body?: unknown) => Promise<Response>;
type AuthenticateUser = (request: Request) => Promise<AuthUser | null>;

const DEVICE_TTL_MS = 10 * 60 * 1000;

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status = 200): Response {
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
.code{font:700 24px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;background:#f4f4f5;border-radius:12px;padding:12px 14px;text-align:center;margin:18px 0}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:11px 12px;font:inherit}
button{width:100%;margin-top:18px;border:0;border-radius:10px;padding:12px 14px;font:600 15px inherit;background:#111827;color:#fff;cursor:pointer}
.note{font-size:12px;color:#787d85;margin-top:14px}.error{background:#fef2f2;color:#991b1b;border-radius:10px;padding:10px 12px;margin:12px 0}
.success{font-size:44px;text-align:center;margin:4px 0 12px}
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function loginPage(userCode: string, errorMessage = ""): Response {
  const code = htmlEscape(userCode);
  return page(
    "Chat Relay sign in",
    `<h1>Connect Chat Relay</h1>
<p>Sign in to authorize the computer waiting with this device code.</p>
<div class="code">${code || "Enter code below"}</div>
${errorMessage ? `<div class="error">${htmlEscape(errorMessage)}</div>` : ""}
<form method="post" action="/auth/device/approve">
<label for="userCode">Device code</label>
<input id="userCode" name="userCode" required value="${code}" autocomplete="one-time-code">
<label for="login">Login</label>
<input id="login" name="login" required minlength="3" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" autocomplete="username">
<label for="password">Password</label>
<input id="password" name="password" type="password" required minlength="8" maxlength="128" autocomplete="current-password">
<label for="name">Display name <span style="font-weight:400;color:#8b8f97">(new account only)</span></label>
<input id="name" name="name" maxlength="120" autocomplete="name">
<button type="submit">Sign in and connect</button>
<p class="note">If the login does not exist yet, Chat Relay creates it with the password entered here. The device code expires after 10 minutes.</p>
</form>`,
  );
}

export async function handleDeviceAuth(
  request: Request,
  registryCall: RegistryCall,
  authenticateUser: AuthenticateUser,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/device" && request.method === "GET") {
    return loginPage(url.searchParams.get("user_code") ?? "");
  }

  if (path === "/auth/device/start" && request.method === "POST") {
    const body = await request.json<any>().catch(() => null);
    const agentId = String(body?.agentId ?? "").trim();
    const agentName = String(body?.agentName ?? "").trim();
    if (!agentId || !agentName) {
      return Response.json({ error: "agent_identity_required" }, { status: 400 });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const deviceCode = newToken("dev");
      const userCode = formatUserCode(randomCode(8));
      const expiresAt = new Date(Date.now() + DEVICE_TTL_MS).toISOString();
      const source = request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for") ||
        "local";
      const response = await registryCall("/device/start", {
        deviceCodeHash: await hashToken(deviceCode),
        userCode,
        agentId,
        agentName,
        expiresAt,
        sourceHash: await hashToken(source),
      });

      if (response.status === 409) continue;
      if (!response.ok) {
        return new Response(response.body, { status: response.status, headers: response.headers });
      }

      const origin = url.origin;
      return Response.json({
        deviceCode,
        userCode,
        verificationUri: `${origin}/device`,
        verificationUriComplete: `${origin}/device?user_code=${encodeURIComponent(userCode)}`,
        expiresIn: Math.floor(DEVICE_TTL_MS / 1000),
        interval: 2,
      });
    }

    return Response.json({ error: "device_code_generation_failed" }, { status: 503 });
  }

  if (path === "/auth/device/approve" && request.method === "POST") {
    const form = await request.formData();
    const userCode = String(form.get("userCode") ?? "").trim().toUpperCase();
    const login = String(form.get("login") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "");

    const response = await registryCall("/device/approve", { userCode, login, password, name });
    const data = await response.json<any>().catch(() => ({}));
    if (!response.ok) {
      const messageByCode: Record<string, string> = {
        invalid_credentials: "The login or password is incorrect.",
        invalid_login: "Use 3-64 characters: letters, numbers, dot, underscore, or hyphen.",
        device_code_not_found: "This device code was not found.",
        device_code_expired: "This device code expired. Run the CLI login command again.",
        device_code_already_used: "This device code has already been used.",
        account_unavailable: "This account cannot sign in with a password.",
        too_many_attempts: "Too many failed attempts. Try again later.",
      };
      return loginPage(userCode, messageByCode[data.error] ?? "Unable to authorize this device.");
    }

    return page(
      "Chat Relay connected",
      `<div class="success">✓</div>
<h1>Computer authorized</h1>
<p>Signed in as <strong>${htmlEscape(data.user?.name ?? login)}</strong>.</p>
<p>You can close this tab. The terminal will finish connecting automatically.</p>`,
    );
  }

  if (path === "/auth/device/token" && request.method === "POST") {
    const body = await request.json<any>().catch(() => null);
    const deviceCode = String(body?.deviceCode ?? "");
    if (!deviceCode) return Response.json({ error: "device_code_required" }, { status: 400 });

    const response = await registryCall("/device/exchange", {
      deviceCodeHash: await hashToken(deviceCode),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/auth/me" && request.method === "GET") {
    const user = await authenticateUser(request);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const response = await registryCall("/list-agents", { userId: user.id });
    const data = await response.json<any>().catch(() => ({ agents: [] }));
    return Response.json({ user, agents: data.agents ?? [] });
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const user = await authenticateUser(request);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const body = await request.json<any>().catch(() => null);
    const agentId = String(body?.agentId ?? "");
    if (!token || !agentId) return Response.json({ error: "invalid_logout" }, { status: 400 });

    const response = await registryCall("/session/logout-agent", {
      userId: user.id,
      agentId,
      tokenHash: await hashToken(token),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  return null;
}
