# Google login

Chat Relay keeps the existing `owner` account as the legacy administrator/recovery account. Dashboard, ChatGPT connector, and local computer device sign-in use the same verified Google identity.

## Required Google OAuth client

Create a Google OAuth 2.0 Web application client and configure this redirect URI:

`https://chat-relay.anusorn-hank.workers.dev/admin/google/callback`

For another deployment, use the deployment origin plus `/admin/google/callback`.

Configure Worker secrets/variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- optional `GOOGLE_REDIRECT_URI`

Do not commit the client secret.

## Identity rules

- Local computer sign-in (`/device`) only supports Google. Confirm the displayed device code and choose **Continue with Google and authorize computer**. Browser sessions do not automatically approve a computer. The shared `/admin/google/callback` completes approval; the terminal exchanges the code for credentials.
- Unconfigured Google OAuth returns 503 for device sign-in; there is no password fallback or password account creation.
- Use the same Google account for the local computer and ChatGPT connector so the connector can access that account's computers. Existing legacy device sessions remain valid until expired/revoked; `login --force` signs in through Google.
- Google `sub` is the stable external identity.
- Verified Google email is the user-facing account/login identifier.
- Email collision never claims `owner` or an administrator.
- Existing non-admin accounts may be linked by matching email and lose local password credentials.
- New Google identities create non-admin users.
- Normal ChatGPT connector authorization reuses a valid remembered browser session automatically for a previously authorized client; otherwise it shows only `Continue with Google` and never exposes the password form.
- Google browser sessions are remembered for 30 days to make connector reconnects one-click while server-side revocation and user disablement still invalidate them.
- Local password authorization remains available only as the explicit owner recovery path (`/authorize?...&recovery=1`); it is not shown in the normal ChatGPT connector flow.
