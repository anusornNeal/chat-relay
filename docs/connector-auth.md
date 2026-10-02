# Connector authorization resilience

Chat Relay uses Google identity for dashboard, connector, and local computer sign-in; the connector still issues separate OAuth credentials.

## Connector OAuth lifecycle

- Access tokens expire after 1 hour.
- Refresh tokens expire after 90 days and rotate on use.
- A rotated refresh token keeps a 30-second replay record for the exact client and MCP resource.
- If the client retries the same refresh request because the first response was lost or timed out, the relay returns the same access/refresh token response during that replay window instead of returning `invalid_grant`.
- The replay record is checked before active-token lookup, so retrying cannot create a second refresh-token branch.
- The replacement refresh token continues rotating normally.
- Expired replay records are included in the bounded auth-artifact cleanup.

The short replay window intentionally stores the already-issued token response long enough to make network retries idempotent. It is not an extension of the old refresh token lifetime and does not permit a different client or resource to reuse it.

## Separation from Google login

Google OAuth/OIDC verifies browser identity for dashboard login, connector authorization, and local computer device approval through `src/google-auth.ts`. Connector OAuth remains the authorization-code + PKCE flow used by ChatGPT/MCP. Changes to connector refresh behavior must not modify Google login state, account linking, or Google credentials.
