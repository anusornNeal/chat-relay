# chat-relay

Cloudflare Worker and Durable Object relay for one connected local agent. A caller sends JSON over HTTP; the agent receives it over WebSocket and sends back JSON with the same `requestId`. There is no queue or DevFlow integration.

## Configuration

Set two independent secrets with `npx wrangler secret put AGENT_TOKEN` and `npx wrangler secret put CALLER_TOKEN` before deployment. Use long random values. Do not commit token values. For local development, create an ignored `.dev.vars` file containing `AGENT_TOKEN=...` and `CALLER_TOKEN=...`, then run `npm run dev`.

The Durable Object uses one named instance (`default`) and permits one agent connection at a time. It uses Cloudflare's WebSocket hibernation API while the agent is idle. A new agent replaces the old one and fails in-flight requests. Pending requests live in memory; an instance restart fails them, while a connected agent WebSocket can be restored after hibernation.

## API

| Route | Authentication | Behavior |
| --- | --- | --- |
| `GET /health` | None | Worker health |
| `GET /status` | `Bearer CALLER_TOKEN` | `{ "online": true/false }` |
| `GET /agent` | `Bearer AGENT_TOKEN`, WebSocket upgrade | Agent connection |
| `POST /relay` | `Bearer CALLER_TOKEN`, `Content-Type: application/json` | Send `{ "payload": <any JSON> }` |

The agent receives `{ "requestId": "...", "payload": ... }` and must reply with the same shape and `requestId`. A successful caller response has that same shape. The request body and agent message limit is 64 KiB; a missing response times out after 30 seconds. Offline or disconnected agents return HTTP 503, timeouts return 504, malformed JSON returns 400, and oversized request bodies return 413. Unknown or late agent responses are ignored.

## Local integration test

Install dependencies with `npm install`. In one terminal run `npm run dev:test`; in another run `python test/integration.py`. The integration test requires Python's `websockets` package (`python -m pip install websockets`) and checks authentication, validation, status, streaming size rejection, concurrent response matching, replacement, and the 30-second timeout. `npm run dev:test` uses fixed test-only tokens and must only be used locally.

## Local agent

Run the agent with `RELAY_URL` and `AGENT_TOKEN` in the environment, then `npm run agent`.
It connects to `/agent`, reconnects automatically after disconnects, echoes normal payloads,
and responds to `{ "action": "ping" }` with a `pong` payload.

## MCP

`POST /mcp` exposes a stateless Streamable HTTP MCP server for ChatGPT and other MCP clients.
The first POC tool is `ping_agent`, which routes a ping through the existing Durable Object to the connected local agent and returns its pong response.
For this POC the MCP endpoint is intentionally unauthenticated; only the harmless `ping_agent` tool is exposed. Add MCP authentication before exposing privileged agent actions.
