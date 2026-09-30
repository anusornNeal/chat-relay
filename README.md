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

## Zero-checkout CLI

End users do not need this repository. After the npm package is published, the normal command is:

```bash
npx @anusornneal/chat-relay@latest remote
```

First run starts a device-login flow, opens the browser, and shows a short code. The browser page signs in with a Chat Relay login/password; if that login does not exist yet, it creates the account. After approval the CLI receives scoped user-session and agent credentials, stores them outside the project, and connects the local agent.

Subsequent runs reuse the local credentials:

```bash
npx @anusornneal/chat-relay@latest remote
```

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
```

The published package locates its bundled local agent relative to the package itself, so commands work from any working directory. Existing repository users can still run `npm start`; legacy `.dev.vars` credentials are migrated once into the user-level config.

## Authentication and multi-user model

- Browser/device login uses a short-lived device code. Raw user or admin tokens are not typed into the CLI.
- New accounts use a unique login plus password. Passwords are stored only as salted PBKDF2-SHA256 hashes.
- Device start/approval requests and failed password attempts are rate-limited.
- CLI user sessions are opaque random tokens stored server-side only as hashes and expire after 90 days.
- Re-authentication revokes the previous CLI session when possible.
- Each local machine has an independent `agentId` and agent token; agent tokens are stored server-side only as hashes.
- Agent ownership is enforced before an existing machine identity can be reused, preventing shared users from rotating another owner's agent credential.
- Grants map users to agents with scopes: `read`, `write`, `terminal`, `process`, or `*`.
- Logging out revokes the local user session and the owning machine credential.
- `ADMIN_TOKEN` remains separate and protects administration routes.
- The existing legacy owner token remains supported so current ChatGPT MCP URLs continue to work during migration.

ChatGPT MCP supports OAuth 2.1 authorization-code login with PKCE S256. OAuth access tokens are audience-bound to `/mcp`; `offline_access` issues rotating refresh tokens. Dynamic client registration and protected-resource/authorization-server discovery are exposed for compatible MCP clients. The legacy `/mcp?key=<USER_TOKEN>` flow remains supported during migration. Browser/device login is for the zero-checkout local CLI and creates the same registry user/agent model used by OAuth.

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
- `read_file`
- `read_multiple_files`
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
npm run admin -- revoke <userId> <agentId>
npm run admin -- enable-user <userId> false
npm run admin -- enable-agent <agentId> false
npm run admin -- rotate-user <userId>
npm run admin -- rotate-agent <agentId>
```

Create and rotate commands return the new raw token once. Store it on the corresponding client/agent; the registry retains only its hash.

The initial `bootstrap` migrates the legacy `CALLER_TOKEN` and `AGENT_TOKEN` secrets into an owner user and the default agent so an existing installation can upgrade without changing its current ChatGPT URL or local agent token.

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
| `POST /mcp?key=<user token>` | user token | Streamable HTTP MCP |
| `GET /agent?agentId=<id>` | agent Bearer token | Local agent WebSocket |
| `GET /status?agentId=<id>` | user token | Agent online status |
| `POST /relay?agentId=<id>` | user token | Direct JSON relay with scope checks |
| `/admin/*` | admin Bearer token | User/agent/grant administration |

## Runtime limits and controls

- Relay request/response message: 64 KiB.
- One-shot terminal command: max 20 seconds.
- Persistent terminal sessions: up to 8 running sessions per local agent.
- Terminal output buffer: bounded in memory; completed sessions retained for 30 minutes.
- Filesystem reads/writes are bounded and restricted to configured `ALLOWED_ROOTS`.
- Search skips common heavy directories such as `.git`, `node_modules`, `.gradle`, `.idea`, and `.wrangler`.
- The agent blocks a small set of high-risk system-management commands. This is defense in depth, not a security sandbox.

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
