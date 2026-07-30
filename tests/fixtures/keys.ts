/**
 * A structurally valid but obviously fake Ghost Admin API key.
 *
 * Ghost admin keys are `id:secret` where id is 24 hex chars and secret is 64 hex
 * chars, and the secret is decoded from hex to bytes before HS256 signing. The
 * JWT tests only ever needed well-formed hex — they never needed a credential
 * that opens a real blog. A real key lived here until 2026-07-29 and reached
 * public git history as a result.
 */
export const FAKE_KEY_ID = '0'.repeat(24);
export const FAKE_KEY_SECRET = 'a'.repeat(64);
export const FAKE_ADMIN_KEY = `${FAKE_KEY_ID}:${FAKE_KEY_SECRET}`;
