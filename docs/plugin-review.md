# Chat Relay public plugin review runbook

Last revalidated: 2026-09-30

This document is the review/submission dossier for the public Chat Relay remote-MCP plugin. Keep platform-specific review metadata here rather than in core relay behavior.

## Official submission references

Re-check these pages before every submission because requirements can change:

- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/app-guidelines

## Proposed submission shape

- Plugin type: remote MCP server, no ChatGPT custom UI.
- Production MCP URL: `https://chat-relay.anusorn-hank.workers.dev/mcp`
- Transport: Streamable HTTP MCP over HTTPS.
- Authentication: OAuth 2.1 authorization code with PKCE. Normal public onboarding uses the plain `/mcp` URL.
- Legacy `/mcp?key=...` authentication is transitional compatibility only and is not part of the public onboarding or reviewer flow.
- Domain verification challenge: `GET /.well-known/openai-apps-challenge`, backed by the `OPENAI_APPS_CHALLENGE` Worker secret/variable. Its response is exact plain text, not JSON.

## External submission blockers

These cannot be completed purely by repository automation and must be confirmed before clicking Submit:

- [ ] Publisher identity is verified in the OpenAI platform.
- [ ] The submitting account has current Apps Management submission permission.
- [ ] The MCP project uses a currently accepted global data-residency configuration for public review.
- [ ] Production website URL is public.
- [ ] Public support URL is available.
- [ ] Public privacy-policy URL is available.
- [ ] Public terms-of-service URL is available.
- [ ] A dedicated reviewer account/device is provisioned and contains no production administrator secret.
- [ ] Reviewer credentials work without MFA, email, SMS, VPN, or private-network access.
- [ ] The challenge token supplied by the submission portal is configured and the exact challenge URL is verified from the public internet.
- [ ] Final production clean-room demo is completed.
- [ ] Submission portal metadata, availability countries, category, logo, localization, and release notes are reviewed against the current portal.

## OAuth-first reviewer onboarding

1. Add the public MCP server using `https://chat-relay.anusorn-hank.workers.dev/mcp`.
2. Allow ChatGPT to discover protected-resource and authorization-server metadata.
3. Complete OAuth sign-in using the dedicated reviewer account.
4. On the reviewer Windows machine run `npx @anusornneal/chat-relay@latest remote`.
5. Complete browser device authorization. No raw user or agent token needs to be copied.
6. Verify the agent is online with `list_agents` or the dashboard.
7. Exercise the positive and negative cases below.
8. Revoke/retire the reviewer device and verify the old machine credential cannot reconnect.
9. Re-authorize the device using browser login and confirm recovery.

## Capability and permission boundaries

Chat Relay separates user-to-agent grants by scope:

- `read`: identity, filesystem metadata/read/search, agent status.
- `write`: filesystem create/edit/move/delete.
- `terminal`: command execution and persistent terminal sessions.
- `process`: process listing/termination.
- `desktop_read`: screenshot access only.
- `desktop_control`: mouse and keyboard control only.
- `*`: all scopes for explicitly trusted users.

Filesystem access is additionally restricted to the local agent's configured `ALLOWED_ROOTS`. Terminal access and desktop access are separate local opt-ins. Desktop access is disabled by default. Administration is separate from MCP and protected by browser-admin sessions or the operator-only `ADMIN_TOKEN`.

## Tool annotation policy

Every MCP tool exposes all three review-relevant annotations:

- `readOnlyHint`: true only when the operation does not mutate local state.
- `openWorldHint`: true for operations that can interact with arbitrary external desktop/terminal state.
- `destructiveHint`: true for mutation/control/termination operations that can change or remove local state.

The automated `test:submission` check fails if any public tool omits one of these booleans and spot-checks representative read/write/terminal/desktop tools.

## Privacy, telemetry, and retention

The relay transports requested tool inputs/results between ChatGPT and the authorized local agent. Raw file contents, terminal commands/output, screenshot bytes, typed text, click coordinates, passwords, cookies, OAuth tokens, and administrator secrets are not intentionally written to usage or audit telemetry.

Usage telemetry stores only hourly aggregate tool-call counts keyed by user id and agent id. The dashboard queries these counters by time range; detailed tool-call and error history is not retained.

Security/admin audit events store sanitized actor/action/target/result metadata. Audit events default to 180-day retention. Sensitive metadata keys such as password/token/secret/command/content/payload/cookie/CSRF are excluded.

Durable Object state is the production source of truth for identities, grants, sessions, telemetry, and audit state. Repository or npm artifacts are not backups of production Durable Object state.

## Draft listing copy

Name: Chat Relay

Short description: Securely connect ChatGPT to an authorized local Windows computer for bounded file, terminal, process, and opt-in desktop actions.

Long description: Chat Relay exposes a remote MCP endpoint backed by a user-authorized local Windows agent. Users sign in through OAuth and authorize each computer separately. Filesystem access is constrained to configured roots, terminal/process access uses explicit grants, desktop screenshots/control require separate opt-in scopes, and devices can be independently renamed, retired, and re-authorized.

Category: choose an available developer-tools/productivity category from the current submission portal rather than hard-coding a stale category here.

Suggested starter prompts:

- List the files in my connected project folder.
- Read these project files and summarize the implementation.
- Run the project's test command and show me the failures.
- Show which of my authorized PCs are online.
- Capture the Windows desktop after I explicitly enable desktop access.

## Reviewer positive cases

Exactly five representative positive cases:

1. Read-only filesystem: list an allowed project directory and read a bounded text file. Expected: success inside `ALLOWED_ROOTS`, with pagination metadata for large reads.
2. Authorized write: create a temporary text file in an allowed root, read it back, then delete it. Expected: success only for a grant containing `write`.
3. Terminal: run a harmless short command such as printing the current working directory. Expected: bounded output and success for a `terminal` grant.
4. Multi-device routing: list two devices for the same account and ping an explicitly selected online agent. Expected: correct independent device identity and routing.
5. Desktop read: with local desktop opt-in and `desktop_read`, capture a screenshot. Expected: bounded JPEG MCP image content plus coordinate metadata.

## Reviewer negative cases

Exactly three representative negative cases:

1. Filesystem boundary: request a file outside `ALLOWED_ROOTS`. Expected: controlled permission/path error; no file content returned.
2. Scope boundary: use a read-only grant to call a write, terminal, process-kill, or desktop-control tool. Expected: permission denied before local action dispatch.
3. Retired device: retire a connected device and try reconnecting with its previous agent credential. Expected: connection rejected; recovery requires browser re-authorization, not token copying.

## Automated review evidence

Run against an isolated local Worker/test state:

- `npm run test:device-auth` - device login, exchange, ownership isolation, logout/revocation.
- `npm run test:oauth` - discovery, DCR, PKCE, bearer MCP, audience binding, refresh rotation.
- `npm run test:admin-api` - bounded admin users/agents/grants/session APIs.
- `npm run test:admin-auth` - browser administrator sessions/CSRF.
- `npm run test:dashboard` - Worker-hosted dashboard and protected admin API routing.
- `npm run test:usage` - privacy-safe telemetry/aggregates.
- `npm run test:quota` - durable rate/quota enforcement.
- `npm run test:ops` - audit redaction, cleanup, aggregate preservation.
- `npm run test:desktop` - desktop permission gates and MCP image/control contracts.
- `npm run test:device-management` - multi-PC, rename, retire, reconnect, cross-owner isolation.
- `npm run test:submission` - challenge endpoint and complete MCP tool annotations.
- `npm run test:zero-checkout` - clean npm tarball install/remote startup.
- `npm run verify:publish` - package whitelist, review-artifact checks, Worker dry-run, production dependency audit.

## Production clean-room demo

Use a dedicated reviewer user and a dedicated test PC/profile.

1. Start from a machine/profile with no Chat Relay user-level config.
2. Install nothing globally; run the published `npx @anusornneal/chat-relay@<review-version> remote`.
3. Complete browser device authorization.
4. Add the plain production `/mcp` URL in ChatGPT and complete OAuth.
5. Confirm the intended scopes/device are visible.
6. Execute the five positive cases and three negative cases.
7. Confirm dashboard usage/audit entries contain metadata only, not sampled raw content or secrets.
8. Retire the test device and confirm the old agent credential fails closed.
9. Re-authorize and confirm the same owner can recover the device identity.
10. Save only non-sensitive reviewer evidence; never capture production `ADMIN_TOKEN`, raw OAuth tokens, user passwords, or local file contents.

## Release notes draft

Chat Relay public-review candidate adds OAuth-first onboarding, multi-user/multi-PC authorization, bounded filesystem responses, browser admin dashboard, privacy-safe usage telemetry, durable quotas, audit/retention operations, explicit device retirement/recovery, opt-in Windows desktop tools, complete MCP tool annotations, and domain-verification support.
