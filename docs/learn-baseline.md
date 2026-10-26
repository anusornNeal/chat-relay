# Learn baseline v7

Chat Relay exposes the Learn baseline in the `learn_prepare` and `learn_put` MCP tool descriptions for every account, including new accounts. It is guidance for the assistant, **not a background scanner, automatic memory writer, or validation/enforcement layer**. Learn remains account-scoped and advisory.

## When and where to write

- Read relevant context once with `learn_prepare` for a substantial task. For machine-specific work, supply **both** the canonical `projectKey` and actual `agentId`.
- Save only durable, confirmed, reusable instructions or environment facts. Check for an existing memory before adding a duplicate; update stale content rather than accumulating revisions.
- Use `global` for cross-project rules; `project` with the canonical project key for project rules; `agent` with the stable agent ID for machine-specific paths and setup.
- Verify local paths with the selected agent's filesystem stat or `get_config` before use. If a path fails, inspect that agent's allowed roots and rediscover the path, then update its memory. Do not reuse another machine's paths.
- Never save credentials, tokens, `.env` contents, private keys, cookies, raw logs, raw tool output, or full configuration files. Non-secret, confirmed workspace paths and tool locations are allowed.

## Writing format

The `learn_put` fields are `key`, `kind`, `scope`, optional `scopeKey`, `content`, and optional `confidence`.

| Field | Convention |
| --- | --- |
| `key` | One topic; stable descriptive lowercase kebab-case, e.g. `machine-environment`. Preserve reserved keys such as `project-context:architecture`. |
| `kind` | The narrowest fitting type: e.g. `agent_context` for a machine; `workflow` for a repeatable rule. |
| `scope` / `scopeKey` | Choose reuse boundary; project key for `project`, stable agent ID for `agent`. |
| `content` | Concise, scannable Markdown: optional short heading and bullets with verified context, action, condition and revalidation rule. One clear sentence is sufficient for small facts. |
| `confidence` | Reflect certainty, not a fabricated level of precision. |

Do **not** force a rigid template on every entry. A reusable task rule may need only one short bullet. Keep compacted canonical `project_context` records in their existing `- [source-key] fact` format, which the storage compactor recognizes.

### Example: agent-scoped machine environment

**Metadata**: `key=machine-environment`, `kind=agent_context`, `scope=agent`, `scopeKey=<actual-agent-id>`

```md
## Machine environment
- **OS / shell:** Windows, PowerShell
- **Workspace root:** `D:\work`
- **Projects:** `chat-relay` -> `D:\work\chat-relay`
- **Tools:** `node` installed; invoke using the detected path
- **Verify before use:** stat the target path on this agent; on `ENOENT`, rediscover inside allowed roots and update this record
```

The paths above are illustrative, not executable defaults. Learned paths never expand the agent's configured filesystem permissions.

## Resource cost

One `learn_prepare` per relevant task, not on every tool call. Only write Learn when confirmed durable knowledge changes; do not add periodic filesystem scans or per-tool Learning Durable Object reads/writes.
