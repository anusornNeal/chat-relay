# Optional headless desktop accessibility

Chat Relay supports [agent-desktop](https://github.com/vercel-labs/agent-desktop)
as an **opt-in local backend** through the existing `desktop_step` MCP tool.
No new MCP tool, background service, npm dependency, Durable Object or screenshot
upload is added.

## Setup

1. Install `agent-desktop@1.0.2` separately with npm or use the native GitHub release.
2. Verify the CLI using `agent-desktop status`.
3. On the **Local Agent process**, set `DESKTOP_ENABLED=1`,
   `DESKTOP_ACCESSIBILITY_ENABLED=1` and `AGENT_DESKTOP_BIN` to the
   native binary's absolute path, then restart the agent.
   On Windows use the native `agent-desktop-win32-x64.exe`, **not** the npm
   `.cmd` launcher, because invocation uses `execFile` without a shell.

With the flag unset, all existing Computer Use behavior remains unchanged.
The native Windows smoke was run with agent-desktop 1.0.2. Other platforms are
not yet validated through Chat Relay.

## Existing desktop_step tool

Use **one** semantic operation per call. Do not mix physical actions or set
`captureAfter`; use the existing screenshot tool separately when required.

- Snapshot: `actions:[{"type":"accessibility","operation":"snapshot","app":"notepad.exe","maxDepth":5}]`
- Click: `actions:[{"type":"accessibility","operation":"click","ref":"@s123:e8"}]`
- Set: `actions:[{"type":"accessibility","operation":"set-value","ref":"@s123:e9","value":"sample"}]`
- Status: `actions:[{"type":"accessibility","operation":"status"}]`

Snapshot supports `root`, `interactive`, `skeleton` and `maxDepth` (1–8).
Refs are snapshot-scoped and can become stale. A successful click may return
`delivered_unverified`. Observe → act → observe again; never retry an ambiguous
side effect automatically.

## Security and limits

- Snapshot/status require **both** `desktop_control` and `desktop_read`
  grants; click/set-value require `desktop_control`.
- Headless only: no `--headed`, pointer movement, focus stealing or automatic
  fallback to physical input.
- Input validation, 256 KiB CLI output limit, 45 KiB remote-result cap and
  sanitized error details. Large trees return `RESULT_TOO_LARGE`; use a shallower
  snapshot or a subtree ref.
- Accessibility trees and CLI refmaps can contain private data. Do not log
  raw content. Avoid secret/password inputs via `set-value`: the native CLI
  receives the text as a process argument visible to local process inspection.
  The CLI stores local refmaps under its user state directory
  (usually `~/.agent-desktop`); this is **not** Durable Object storage.
- Locked desktops, elevated windows, unsupported accessibility interfaces and
  minimized apps may not work. Existing screenshot-based tools remain available.

## Verification

Unit tests: `node --test test/agent-desktop-adapter.test.mjs`.
MCP and grant smoke (requires local test Worker): `npm run test:desktop`.
A local 30-run observation benchmark measures CLI snapshot vs JPEG capture
overhead, **not** equivalent task completion or model reasoning time.

No auto-install, production release or multi-user reference isolation guarantee
is implied by this optional integration.
