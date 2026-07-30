// src/plugins/platforms/wordpress/auth.ts

/**
 * HTTP Basic credentials for the WordPress REST API.
 *
 * Confirmed by live probe on 2026-07-29 against a real WordPress install: Basic
 * auth with a WordPress core Application Password (no plugin installed)
 * authenticated successfully across every endpoint probed (`users/me`, posts,
 * tags, media).
 *
 * The password is sent exactly as given, spaces included if the caller's
 * `.env` value has them (WordPress displays a newly generated Application
 * Password in space-separated groups). Whether a password containing those
 * spaces authenticates as-is, rather than only after stripping them, was not
 * independently isolated by the 2026-07-29 probe — the site's stored
 * credential simply worked — so this specific nuance stays a reasonable
 * inference, not a dedicated measurement. Stripping the spaces regardless
 * would be an unnecessary transformation risking breaking a paste that would
 * otherwise have worked, so it is never done.
 */
export function basicAuthHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}
