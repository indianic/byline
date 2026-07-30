import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import { ghostToken } from '../../../src/plugins/platforms/ghost/auth.js';
import { FAKE_KEY_ID, FAKE_KEY_SECRET } from '../../fixtures/keys.js';

const ID = FAKE_KEY_ID;
const SECRET = FAKE_KEY_SECRET;
const KEY = `${ID}:${SECRET}`;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('ghostToken', () => {
  it('puts the key id in the header kid and uses HS256', () => {
    const [h] = ghostToken(KEY, 'personal', 1_700_000_000).split('.');
    expect(decode(h!)).toEqual({ alg: 'HS256', typ: 'JWT', kid: ID });
  });

  it('sets aud to /admin/ and a five-minute expiry', () => {
    const [, p] = ghostToken(KEY, 'personal', 1_700_000_000).split('.');
    expect(decode(p!)).toEqual({ iat: 1_700_000_000, exp: 1_700_000_300, aud: '/admin/' });
  });

  it('signs with the hex-decoded secret, not the hex string', () => {
    const [h, p, sig] = ghostToken(KEY, 'personal', 1_700_000_000).split('.');
    const expected = createHmac('sha256', Buffer.from(SECRET, 'hex'))
      .update(`${h}.${p}`)
      .digest('base64url');
    expect(sig).toBe(expected);

    const wrong = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
    expect(sig).not.toBe(wrong);
  });

  it('rejects a key with no colon and names the site', () => {
    try {
      ghostToken('nocolon', 'indianic');
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('BAD_KEY_FORMAT');
      expect(err.message).toContain('indianic');
      expect(err.message).not.toContain('nocolon');
    }
  });

  it('rejects a non-hex secret', () => {
    try {
      ghostToken(`${ID}:zzzz`, 'personal');
    } catch (e) {
      expect((e as ToolError).code).toBe('BAD_KEY_FORMAT');
    }
  });
});
