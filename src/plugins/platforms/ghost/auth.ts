import { createHmac } from 'node:crypto';
import { ToolError } from '../../../errors.js';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * Build a Ghost Admin API JWT.
 *
 * The admin key is `id:secret` where `secret` is HEX. It must be decoded to bytes
 * before signing — signing the hex string produces a token Ghost rejects with a
 * bare 401. Verified against Ghost 6.44 on 2026-07-28.
 */
export function ghostToken(
  adminApiKey: string,
  slug: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const parts = adminApiKey.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ToolError({
      api: `ghost:${slug}`,
      code: 'BAD_KEY_FORMAT',
      message: `Admin key for site "${slug}" is not in id:secret form`,
      hint: 'Copy the Admin API Key from Ghost Admin > Settings > Integrations',
    });
  }
  const [id, secret] = parts as [string, string];

  if (!/^[0-9a-f]+$/i.test(secret) || secret.length % 2 !== 0) {
    throw new ToolError({
      api: `ghost:${slug}`,
      code: 'BAD_KEY_FORMAT',
      message: `Admin key secret for site "${slug}" is not hexadecimal`,
      hint: 'The part after the colon must be hex — you may have pasted a Content API key',
    });
  }

  const header = b64({ alg: 'HS256', typ: 'JWT', kid: id });
  const payload = b64({ iat: nowSeconds, exp: nowSeconds + 300, aud: '/admin/' });
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}
