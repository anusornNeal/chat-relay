# Google login

Chat Relay keeps the existing `owner` account as the legacy administrator/recovery account. Dashboard and ChatGPT connector sign-in can use the same verified Google identity.

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

- Google `sub` is the stable external identity.
- Verified Google email is the user-facing account/login identifier.
- Email collision never claims `owner` or an administrator.
- Existing non-admin accounts may be linked by matching email and lose local password credentials.
- New Google identities create non-admin users.
- ChatGPT connector authorization offers Google sign-in first and keeps local password login as the owner recovery fallback.
