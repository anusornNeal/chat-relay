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

## Authentication and multi-user model

- Each user has an independent opaque user token.
- Each local machine has an `agentId` and independent agent token.
- User tokens and agent tokens are stored in Cloudflare only as SHA-256 hashes.
- Grants map users to agents with scopes: `read`, `write`, `terminal`, `process`, or `*`.
- A user with one permitted agent can omit `agentId`; with multiple permitted agents the tool call must select one.
- `ADMIN_TOKEN` protects the administration API.
- ChatGPT can authenticate with `/mcp?key=<USER_TOKEN>`. Bearer auth is also accepted by the server for non-ChatGPT clients.

The query-string user token is practical for the current ChatGPT custom MCP flow, but OAuth should be preferred if this is later exposed to a broad external audience.

## Local agent configuration

Copy `.dev.vars.example` to ignored `.dev.vars` and configure at least:

```
RELAY_URL=https://<worker>.workers.dev
AGENT_ID=default
AGENT_NAME=Primary PC
AGENT_TOKEN=<agent token>
TERMINAL_ENABLED=1
ALLOWED_ROOTS=C:\Users\you\Projects
```

Run:

```
npm install
npm run agent
```

The agent reconnects automatically.

`ALLOWED_ROOTS` is a semicolon-separated list used by filesystem tools. Terminal commands are a separate capability and are controlled by the `terminal` grant plus `TERMINAL_ENABLED`.

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
