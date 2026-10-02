# Chat Relay

Remote MCP relay that lets ChatGPT work with a local Windows or macOS machine through a Cloudflare-hosted relay.

## Quick start

There are two parts:

1. Connect ChatGPT to the relay.
2. Run the local agent on the computer you want ChatGPT to access.

### 1. Connect to ChatGPT

Add the production MCP server to ChatGPT:

```text
https://chat-relay.anusorn-hank.workers.dev/mcp
```

Complete the OAuth sign-in when ChatGPT opens the authorization flow.

ChatGPT connects to the cloud relay. To actually access files, terminal, processes, or desktop controls on a computer, that computer must also be running the local agent below.

### 2. Run the local agent with `npx`

Requirements: Node.js 20 or newer.

From any directory:

```bash
npx @anusornneal/chat-relay@latest remote
```

On the first run, Chat Relay opens browser-based device authorization. Sign in, approve the computer, then return to the terminal.

The CLI saves the device credentials in your user profile, so later you can reconnect with the same command:

```bash
npx @anusornneal/chat-relay@latest remote
```

Enable desktop screenshot, mouse, and keyboard access:

```bash
npx @anusornneal/chat-relay@latest remote --desktop
```

Limit filesystem access to a specific root:

```bash
npx @anusornneal/chat-relay@latest remote --root "C:\Users\you\Projects"
```

## `npx` commands

| Command | What it does |
| --- | --- |
| `npx @anusornneal/chat-relay@latest remote` | Connects this computer to Chat Relay and keeps the local agent running. Enables the capabilities allowed for this device, such as files, terminal, and processes. |
| `npx @anusornneal/chat-relay@latest remote --desktop` | Starts the agent with desktop screenshot/input support enabled. Desktop permissions must also be granted by the relay. |
| `npx @anusornneal/chat-relay@latest login` | Signs in and registers this computer without starting the long-running agent. |
| `npx @anusornneal/chat-relay@latest login --force` | Forces a fresh sign-in and device authorization. Useful when credentials were revoked or need to be replaced. |
| `npx @anusornneal/chat-relay@latest status` | Shows the signed-in account, device, relay URL, online state, scopes, agent version, protocol compatibility, lifecycle state, allowed roots, and desktop state. |
| `npx @anusornneal/chat-relay@latest drain` | Stops accepting new long-running work so active work can finish before a restart. |
| `npx @anusornneal/chat-relay@latest resume` | Cancels drain mode and resumes normal work admission. |
| `npx @anusornneal/chat-relay@latest restart` | Restarts the local agent after drain has completed and the agent is ready to restart. |
| `npx @anusornneal/chat-relay@latest logout` | Revokes this computer login and removes its local credentials. |
| `npx @anusornneal/chat-relay@latest help` | Shows CLI usage and available options. |

Useful options:

```text
--root <path>       Allowed filesystem root. Use semicolons for multiple roots.
--name <name>       Computer display name.
--agent-id <id>     Stable agent identifier.
--desktop           Enable desktop access.
--no-desktop        Disable desktop access.
--no-open           Do not open the login browser automatically.
--force             Force a new login.
--relay <url>       Use another Chat Relay deployment.
```

## What ChatGPT can access

Depending on the device grants and local configuration, Chat Relay can expose:

- Filesystem operations inside configured allowed roots.
- Terminal commands and persistent terminal sessions.
- Process inspection and termination.
- Windows/macOS screenshots, mouse input, and keyboard input when desktop access is explicitly enabled.
- Multiple computers under one account, with per-device routing and permissions.
- Batched filesystem, terminal, and desktop operations to reduce remote round trips.

Desktop access is opt-in. Linux desktop control is not currently implemented.

## How it works

```text
ChatGPT
   |
   | Streamable HTTP MCP + OAuth
   v
Cloudflare Worker
   |
   +-- Registry Durable Object
   |
   +-- Relay Durable Object
           |
           | WebSocket
           v
      Local Agent
      - files
      - terminal
      - processes
      - desktop
```

ChatGPT talks only to the cloud MCP endpoint. The local computer opens the outbound WebSocket connection to the relay.

## Security model

- ChatGPT MCP authentication uses OAuth 2.1 authorization code flow with PKCE.
- Local computers use browser/device authorization; raw agent tokens do not need to be copied manually.
- Filesystem access is constrained to configured allowed roots.
- Access is scope-based: read, write, terminal, process, desktop read, and desktop control can be granted separately.
- Desktop access is disabled by default.
- Stored credentials are hashed server-side where applicable.
- Persisted usage/audit telemetry is metadata-only and excludes commands, file contents, screenshots, clipboard contents, and credentials.

Chat Relay is currently intended for small trusted teams rather than an enterprise zero-trust control plane.

## Local configuration

Default CLI config locations:

- Windows: `%LOCALAPPDATA%\chat-relay\config.json`
- macOS/Linux: `$XDG_CONFIG_HOME/chat-relay/config.json` or `~/.config/chat-relay/config.json`

Set `CHAT_RELAY_HOME` to override the config directory.

A single account can own multiple computers. Each computer keeps its own agent identity and credential.

## Development

Clone the repository only when developing Chat Relay itself. Normal users should use the zero-checkout `npx` flow above.

Common development commands:

```bash
npm install
npm start
npm run dev
npm run verify:publish
```

`npm run verify:publish` checks the publish file set, CLI entrypoint, Worker dry-run build, review artifacts, and production dependency audit.

## Administration

Administration is separate from the public MCP interface. The admin tooling manages users, agents, grants, lifecycle, quotas, audit data, and operational cleanup.

Operator commands are available through:

```bash
npm run admin -- <command>
```

Keep `ADMIN_TOKEN` and other deployment secrets out of client configuration and source control.

## Platform notes

- Local agent: Windows and macOS.
- Desktop control: Windows and macOS.
- Linux desktop control: not implemented.
- MCP transport: Streamable HTTP over HTTPS.
- Local agent transport: outbound WebSocket.
- Node.js: 20+.

## More information

- Public plugin/reviewer flow: `docs/plugin-review.md`
- Google sign-in setup: `docs/google-login.md`
- Source: https://github.com/anusornNeal/chat-relay
