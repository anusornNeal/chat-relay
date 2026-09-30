# chat-relay

Cloudflare Worker + Durable Objects relay that exposes one or more local Windows agents to ChatGPT through remote MCP.

```
ChatGPT / MCP client
        |
        | Streamable HTTP MCP
        v
Cloudflare Worker
        |
        +-- Registry Durable Object (users, agents, grants)
        |
        +-- Relay Durable Object per agent
                    |
                    | WebSocket
                    v
             Local Agent
             - terminal
             - files
             - processes
```

The relay is generic and has no Devflow-specific logic.

## Quick start

The CLI is published on npm. You do **not** need to clone this repository or run `npm install`.

From any directory:

```bash
npx @anusornneal/chat-relay@latest remote
```

On the first run, Chat Relay opens a browser-based device login. Sign in, approve the computer, then return to the terminal. The CLI saves its credentials in your user profile and connects the local agent automatically.

Later, use the same command from anywhere:

```bash
npx @anusornneal/chat-relay@latest remote
```

A successful connection looks like:

```text
Chat Relay Remote
-----------------
Agent:      Primary PC (default)
Terminal:   enabled
Desktop:    disabled
Agent connected
```

## Zero-checkout CLI

Other commands:

```bash
npx @anusornneal/chat-relay@latest login
npx @anusornneal/chat-relay@latest status
npx @anusornneal/chat-relay@latest logout
```

On Windows the config defaults to `%LOCALAPPDATA%\chat-relay\config.json`. On macOS/Linux it uses `$XDG_CONFIG_HOME/chat-relay/config.json` or `~/.config/chat-relay/config.json`. Set `CHAT_RELAY_HOME` to override the location.

Useful options:

```bash
chat-relay remote --root "C:\Users\you\Projects"
chat-relay login --name "Work PC"
chat-relay login --no-open
chat-relay remote --desktop
chat-relay remote --no-desktop
```

The published package locates its bundled local agent relative to the package itself, so commands work from any working directory. Existing repository users can still run `npm start`; legacy `.dev.vars` credentials are migrated once into the user-level config.

## Dashboard administrator sessions

Browser dashboard access uses the same Chat Relay username/password accounts but requires an explicit global administrator entitlement. Successful dashboard login creates a short-lived opaque server-side session; the browser receives an HttpOnly, Secure, SameSite=Strict cookie plus a CSRF token for state-changing requests. `ADMIN_TOKEN` remains an operator/CLI recovery credential and must never be embedded in dashboard JavaScript, browser storage, or URLs.
## Authentication and multi-user model

- Browser/device login uses a short-lived device code. Raw user or admin tokens are not typed into the CLI.
- New accounts use a unique login plus password. Passwords are stored only as salted PBKDF2-SHA256 hashes.
- Device start/approval requests and failed password attempts are rate-limited.
- CLI user sessions are opaque random tokens stored server-side only as hashes and expire after 90 days.
- Re-authentication revokes the previous CLI session when possible.
- Each local machine has an independent `agentId` and agent token; agent tokens are stored server-side only as hashes.
- Agent ownership is enforced before an existing machine identity can be reused, preventing shared users from rotating another owner's agent credential.
- Grants map users to agents with scopes: `read`, `write`, `terminal`, `process`, `desktop_read`, `desktop_control`, or `*`. Explicit legacy grants do not gain desktop access automatically.
- Logging out revokes the local user session and the owning machine credential.
- `ADMIN_TOKEN` remains separate and protects administration routes.
- The existing legacy owner token remains supported only as transitional compatibility while OAuth becomes the normal ChatGPT MCP path.

ChatGPT MCP should connect to the plain `/mcp` endpoint. Compatible clients discover OAuth 2.1 automatically, then use authorization-code login with PKCE S256. OAuth access tokens are audience-bound to `/mcp`; `offline_access` issues rotating refresh tokens. Dynamic client registration and protected-resource/authorization-server discovery are exposed for compatible MCP clients. The legacy `/mcp?key=<USER_TOKEN>` flow remains available only during migration. Browser/device login is for the zero-checkout local CLI and creates the same registry user/agent model used by OAuth.

## MCP tools

Identity and agent routing:
- `whoami`
- `list_agents`
- `ping_agent`
- `get_config`
- `get_recent_tool_calls`

Filesystem:
- `stat_path`
- `list_directory`
- `read_file` - bounded by bytes; returns `truncated` and `nextOffset` when more lines remain
- `read_multiple_files` - bounded aggregate response; supports string paths or per-file `{ path, offset, length, maxBytes }` entries plus `maxTotalBytes`
- `start_search`
- `get_more_search_results`
- `write_file`
- `edit_block`
- `create_directory`
- `move_path`
- `delete_path`

Processes:
- `list_processes`
- `kill_process`

Terminal:
- `terminal_exec`
- `terminal_start`
- `terminal_start_shell`
- `terminal_read`
- `terminal_write`
- `terminal_list`
- `terminal_kill`

Desktop (Windows, opt-in):
- `screenshot` - returns a bounded MCP image content block plus coordinate metadata
- `mouse_click` - left/right/middle single or double click in desktop coordinates
- `keyboard_input` - Unicode text or named key/modifier chord

Desktop-Commander-compatible aliases:
- `start_process`
- `read_process_output`
- `interact_with_process`
- `list_sessions`
- `force_terminate`

## Administration

Administration is intentionally separate from MCP. Set the Cloudflare `ADMIN_TOKEN` secret, keep the same value in the local ignored `.dev.vars` on the administrator machine, and use:

```
npm run admin -- state
npm run admin -- bootstrap default "Primary PC"
npm run admin -- create-user "Alice"
npm run admin -- create-agent "Work Laptop" work-laptop
npm run admin -- grant <userId> <agentId> read,write,terminal,process
npm run admin -- grant <userId> <agentId> desktop_read
npm run admin -- grant <userId> <agentId> desktop_read,desktop_control
npm run admin -- revoke <userId> <agentId>
npm run admin -- enable-user <userId> false
$env:CHAT_RELAY_PASSWORD="choose-a-password"; npm run admin -- set-login <userId> <login>
npm run admin -- enable-agent <agentId> false
npm run admin -- rotate-user <userId>
npm run admin -- rotate-agent <agentId>
```

Create and rotate commands return the new raw token once. Store it on the corresponding client/agent; the registry retains only its hash.

The initial `bootstrap` migrates the legacy `CALLER_TOKEN` and `AGENT_TOKEN` secrets into an owner user and the default agent. To move that existing owner to OAuth without creating a duplicate account, set `CHAT_RELAY_PASSWORD` in the administrator shell and run `npm run admin -- set-login owner <login>`. This attaches login credentials to the same owner user, preserving its grants and agent ownership.

## Worker routes

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | none | Worker health |
| `GET /.well-known/oauth-protected-resource[/mcp]` | none | MCP protected-resource metadata |
| `GET /.well-known/oauth-authorization-server` | none | OAuth authorization-server metadata |
| `POST /register` | none | Dynamic registration for public PKCE clients |
| `GET/POST /authorize` | login/password | OAuth authorization-code sign-in |
| `POST /token` | public client + PKCE/refresh token | Access/refresh token exchange |
| `POST /auth/device/start` | none | Start CLI device authorization |
| `GET /device?user_code=<code>` | none | Browser sign-in/approval page |
| `POST /auth/device/approve` | login/password + device code | Approve or create a user account |
| `POST /auth/device/token` | device code | Exchange approved device code for session/agent credentials |
| `GET /auth/me` | user Bearer token | Current user and permitted agents |
| `POST /auth/session/revoke` | user Bearer token | Revoke only the current user session |
| `POST /auth/logout` | user Bearer token | Revoke local session and owning agent credential |
| `POST /mcp` | OAuth Bearer token | Streamable HTTP MCP (normal path) |
| `POST /mcp?key=<user token>` | legacy user token | Transitional Streamable HTTP MCP compatibility |
| `GET /agent?agentId=<id>` | agent Bearer token | Local agent WebSocket |
| `GET /status?agentId=<id>` | user token | Agent online status |
| `POST /relay?agentId=<id>` | user token | Direct JSON relay with scope checks |
| `/admin/*` | admin Bearer token | User/agent/grant administration |

## Windows desktop access (opt-in)

Desktop interaction is disabled by default and requires two independent gates:

1. Enable the local agent with `chat-relay remote --desktop` or `DESKTOP_ENABLED=1`. The CLI persists this setting locally. Use `--no-desktop` to disable it again.
2. Grant `desktop_read` for screenshots and/or `desktop_control` for mouse/keyboard input. Generic read/write/terminal/process scopes do not imply desktop access.

- `screenshot` captures the primary interactive Windows display, scales/compresses it to a bounded JPEG, and returns it as an MCP image block. The accompanying metadata contains image size, desktop origin/size, and scale factors for converting screenshot pixels to desktop coordinates.
- `mouse_click` accepts integer desktop x/y coordinates, button `left|right|middle`, and click count 1 or 2. Invalid/out-of-bounds input is rejected rather than coerced.
- `keyboard_input` accepts either Unicode `text` or one named `key` with optional Ctrl/Alt/Shift/Win modifiers. Text and key cannot be supplied together.
- Windows interactive sessions are the v1 target. Non-Windows agents return `unsupported_platform`; unavailable/locked/non-interactive desktops return a controlled session/capture/input error and do not crash the reconnect loop.
- Screenshot bytes, typed text, key chords, and click coordinates are not stored in recentCalls. Only action/timing/success metadata is retained there.
- This card does not add streaming video, OCR, remote-desktop viewer UI, clipboard sync, drag-and-drop, app-specific automation, or Session 0/service automation.

## Runtime limits and controls

- MCP tool calls are protected by per-user durable limits before local-agent dispatch. Defaults are 120 calls per 60-second window and 10,000 calls per UTC day. Set `USER_RATE_LIMIT_PER_WINDOW=0` or `USER_DAILY_CALL_QUOTA=0` to disable that limit; `USER_RATE_WINDOW_SECONDS` controls the rate window (1-3600 seconds).
- Admins can inspect or override the effective policy with `GET/POST /admin/api/limits`; POST `{ "resetToDefaults": true }` returns to environment defaults. Rejections return HTTP 429 with `rate_limited` or `quota_exceeded`, `Retry-After`, and reset metadata, and are recorded as bounded usage events without dispatching agent work.
- Relay request/response message: 64 KiB. The local agent caps serialized responses below that transport ceiling and returns `response_too_large` instead of allowing a silent timeout.
- `read_file` defaults to a 32 KiB content budget (max 48 KiB) and exposes deterministic `nextOffset` continuation.
- `read_multiple_files` defaults to a 48 KiB aggregate budget (max 48 KiB). If not all requested files fit, use `nextIndex`; if an individual file is truncated, continue it with that entry's `nextOffset`.
- One-shot terminal command: max 20 seconds.
- Persistent terminal sessions: up to 8 running sessions per local agent.
- Terminal output buffer: bounded in memory; completed sessions retained for 30 minutes.
- Filesystem reads/writes are bounded and restricted to configured `ALLOWED_ROOTS`.
- Search skips common heavy directories such as `.git`, `node_modules`, `.gradle`, `.idea`, and `.wrangler`.
- The agent blocks a small set of high-risk system-management commands. This is defense in depth, not a security sandbox.

## Audit, retention, and recovery

- Security/admin mutations are recorded in a dedicated `Audit` Durable Object with actor, action, target, result, and sanitized scalar metadata only. Passwords, tokens, cookies, CSRF values, commands, file content, and raw tool payloads are excluded.
- Raw usage events default to 30-day retention while daily usage aggregates are preserved independently. Set `USAGE_RAW_RETENTION_DAYS` to change raw-event retention.
- Audit events default to 180-day retention. Set `AUDIT_RETENTION_DAYS` to change that window.
- `GET /admin/api/audit` returns bounded audit history. `GET /admin/api/operations` exposes component health and last cleanup state. `POST /admin/api/operations/cleanup` performs bounded idempotent cleanup across registry auth transients, raw usage events, and audit history.
- Cleanup does not intentionally remove active users, grants, agents, live sessions, pending non-expired device authorization, or long-lived usage aggregates.
- Durable Object state is the production source of truth. Git/npm artifacts do not back it up. Before destructive migration or account transfer, export any operator-required identity/config state separately and treat Cloudflare account/Durable Object recovery controls as the infrastructure recovery boundary.
- Cleanup failures are surfaced through the operations endpoint and audit result instead of being silently treated as success.
## Tests

The legacy relay integration test remains available:

```
npm run dev:test
python test/integration.py
```

The full MCP/multi-user smoke test expects a local Worker on port 8795 plus an attached local agent:

```
node test/multiuser-smoke.mjs
```

It verifies the MCP tool surface, agent routing, filesystem operations, search sessions, process listing, persistent terminals, scope enforcement, multi-agent selection, and token rotation.

Device/browser login is covered by:

```bash
TEST_RELAY_URL=http://127.0.0.1:8796 npm run test:device-auth
```

OAuth discovery, DCR, PKCE, token exchange, refresh rotation, audience binding, MCP Bearer auth, and legacy-key compatibility are covered by:

```bash
TEST_RELAY_URL=http://127.0.0.1:8796 npm run test:oauth
```

Per-user rate/quota enforcement, isolation, reset-window behavior, disabled policy, rejection observability, and pre-dispatch blocking are covered by:

```bash
TEST_RELAY_URL=http://127.0.0.1:8804 npm run test:quota
```

Desktop tool contracts, scope separation, disabled/unsupported gates, controlled image mapping, and input validation are covered by:

```bash
TEST_RELAY_URL=http://127.0.0.1:8807 npm run test:desktop
```

After `npm pack`, the zero-checkout package smoke test installs and runs the tarball from a temporary directory:

```bash
CHAT_RELAY_TARBALL=<path-to-tgz> TEST_RELAY_URL=http://127.0.0.1:8796 npm run test:zero-checkout
```

The npm package is configured as `@anusornneal/chat-relay`. Publishing requires an authenticated npm account with access to that scope.

## CI and npm publishing

GitHub Actions runs package verification on Node 20 and Node 24. A separate integration job starts a local Worker and verifies device auth, OAuth, and the zero-checkout tarball flow.

Before publishing locally:

```bash
npm run verify:publish
```

This checks the npm file set, CLI entrypoint, Worker dry-run build, and production dependency audit. The package whitelist excludes .dev.vars, Worker source, tests, and repository-only files.

The repository also includes a Publish npm workflow for version tags or manual dispatch. It supports npm trusted publishing through GitHub OIDC and can also use an NPM_TOKEN repository secret when configured.

The first registry publish still requires npm authorization for the @anusornneal scope. After publishing, verify the exact public UX from a clean directory:

```bash
npx @anusornneal/chat-relay@latest status
npx @anusornneal/chat-relay@latest remote
```
