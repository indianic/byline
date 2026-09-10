// src/plugins/platforms/linkedin/auth.ts

/**
 * LinkedIn's REST and OpenID Connect (`/v2/userinfo`) surfaces both take a
 * plain OAuth 2.0 bearer token — UNVERIFIED, reasoned from LinkedIn's
 * published API documentation, not measured against a live token. See the
 * header comment on `linkedin/index.ts` for what "UNVERIFIED" means for this
 * whole plugin.
 */
export function bearerAuthHeader(accessToken: string): string {
  return `Bearer ${accessToken}`;
}
