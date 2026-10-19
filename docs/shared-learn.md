# Shared Learn Groups

Shared Learn lets multiple Chat Relay accounts collaborate on **approved project conventions** without granting access to each other's personal Learn memories.

## Use in Dashboard

1. Open **My Learn → Shared Learn → Create group**. Enter a name and canonical project key, such as `Buddy2` / `buddy2`. The creator becomes **Owner**.
2. Owner opens **Members**, selects an existing account by **email** (fallback display name if no email), and assigns its role. The ID stays an internal value only; the directory excludes disabled, deleted, and existing members.
3. If teammates use different repository folder names, Owner opens **Project aliases** and adds the alternate keys (e.g. `buddy-android`). Alias changes are explicit and group-scoped; no guesses from unrelated paths.
4. A Member or Editor opens **My Learn**, selects a project-scoped memory and clicks **Share to group**. The system makes a **proposal copy** of that account's own record. Nothing is auto-shared; Global and Agent memories cannot be shared this way.
5. Owner/Editor reviews under **Shared Learn → Pending** and selects Approve or Reject. If a different approved rule has the same kind/key, a separate replacement confirmation is required. Only approved memories are read by other members.
6. An authenticated member calling `learn_prepare` for the matching project (or its explicit alias) receives bounded, approved group rules alongside their personal context. Group rules have project precedence within advisory Learn, not permission to override the user's current request, auth, grants or safety.

## Add Learn directly

In a Shared Learn group, Owner, Editor, and Member can select **Add Learn** (also shown when the Approved list is empty). Choose **Create new Learn** (key/type/Markdown up to 4,000 characters) or **Select from Private Learn** (your own matching project memories only; explicitly fetched when opening that mode). Either choice creates a **Pending** proposal, never a published rule. Viewer cannot add new entries.

Only an approved proposal is used as shared project context. To reuse a personal rule instead, keep using **My Learn > Share to group**. Both paths preserve the same review gate and group permissions.

## Roles

| Role | Read approved | Propose | Review others | Manage membership/aliases |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes | Yes |
| Editor | Yes | Yes | Yes, except own proposals | No |
| Member | Yes | Yes | No | No |
| Viewer | Yes | No | No | No |

Non-members receive a 404 even when they know a group ID. Revoked members cannot read new shared context; active chat context already retrieved cannot be retroactively removed. Disabled/deleted accounts must be denied by the existing user/session authentication layer.

## API (browser authenticated, CSRF enforced for writes)

- `GET /admin/api/learn/groups` — list groups accessible to current browser account.
- `POST /admin/api/learn/groups` — create `{ name, projectKey }`.
- `GET /admin/api/learn/groups/:id` — read authorized group, members, approved items and permitted proposals.
- `POST /admin/api/learn/groups/:id/members` — Owner adds existing user `{ userId, role }`.
- `DELETE /admin/api/learn/groups/:id/members/:userId` — Owner revokes member (not Owner).
- `POST /admin/api/learn/groups/:id/aliases` — Owner adds `{ alias }`.
- `POST /admin/api/learn/groups/:id/aliases/remove` — Owner removes `{ alias }`.
- `POST /admin/api/learn/groups/:id/proposals` — current account proposes its own `{ memoryId }` project memory.
- `POST /admin/api/learn/groups/:id/review` — Owner/Editor reviews `{ proposalId, decision: "approve"|"reject", replace?: boolean }`.

- `POST /admin/api/learn/groups/:id/learn` - Owner/Editor/Member submits `{ key, kind, content }` as a new Pending group proposal; does not create personal memory or approve it.

## Chat and Learn routing

Chat clients can use `learn_group_list`, `learn_group_get`, `learn_group_propose` and `learn_group_review` with the authenticated Chat Relay account. `learn_group_propose` accepts either one personal `sourceMemoryId` (project scope only) **or** one new `key`, `kind`, `content` Markdown record. Neither route approves automatically. Approvals/rejections should be explicitly requested and visible in Group Pending/History.

For ordinary project work, the chat invokes `learn_prepare` once with a resolvable project key. Its result includes **approved** matching Shared Learn from accessible Groups (including configured project aliases), ranked alongside personal context with shared provenance. Pending proposals are never included, and routine Relay tool calls incur no group read.

## Resource boundaries

Shared group metadata and snapshots live in a lazily initialized dedicated `Learning` Durable Object instance (`shared-learn-groups:v1`), **not** an individual account's Learning DO. Access checks happen inside group storage, and group lookup is made only for explicit `learn_prepare` for a resolved project (or explicit group UI/API access). It adds one DO round trip per relevant prepare; **no per ordinary-MCP-toolcall reads/writes**. Shared prepare is limited to four matching groups / 32 records; list and history queries are bounded. Personal preparation continues if group service is unavailable.

Security note: group status depends on the current authenticated account, never an actor ID supplied by the browser. Shared Learn never exports raw terminal data or performs automatic sharing.

## Verification

- `npm run test:learn` — SQL group lifecycle, roles, alias, approval and revocation, UI empty-state and safe Markdown tests.
- `npm run test:learn-bootstrap` — relevance and account-scoped prepare contract.
- `npm run test:dashboard-timers` and `node --test test/learn-markdown.test.mjs` — existing Dashboard behaviors.
- `npx wrangler deploy --dry-run --config wrangler.production.jsonc` — Worker build and asset binding verification.

Screenshots / browser checks at 1440×900 and 800×900 were run using Edge Chromium with deterministic mocked API responses. They verify visual layout, not live end-to-end authentication.
