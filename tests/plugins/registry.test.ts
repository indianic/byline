import { describe, expect, it } from 'vitest';
import { PLATFORM_IDS, PLATFORM_PLUGINS, getPlugin } from '../../src/plugins/registry.js';
import { ToolError } from '../../src/errors.js';

describe('plugin registry', () => {
  it('registers ghost', () => {
    expect(Object.keys(PLATFORM_PLUGINS)).toContain('ghost');
  });

  it('throws a named error for an unknown platform', () => {
    try {
      getPlugin('joomla');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('UNKNOWN_PLATFORM');
      // The message must list what IS supported, or the user has to read source.
      expect((e as ToolError).message).toContain('ghost');
    }
  });

  it('derives the ghost admin endpoint from the site url', () => {
    expect(getPlugin('ghost').defaultApiUrl('https://blog.example.com')).toBe(
      'https://blog.example.com/ghost/api/admin',
    );
  });

  it('recognises a 24-hex ghost author id but not a persona slug', () => {
    const ghost = getPlugin('ghost');
    expect(ghost.isAuthorId('0'.repeat(24))).toBe(true);
    expect(ghost.isAuthorId('jane-doe')).toBe(false);
    expect(ghost.isAuthorId('123')).toBe(false);
  });

  it('accepts a valid ghost credential block', () => {
    const parsed = getPlugin('ghost').credentialSchema.safeParse({
      platform: 'ghost',
      url: 'https://blog.example.com',
      admin_api_key: '${MY_KEY}',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a ghost block missing admin_api_key', () => {
    const parsed = getPlugin('ghost').credentialSchema.safeParse({
      platform: 'ghost',
      url: 'https://blog.example.com',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('credential fields', () => {
  it('ghost declares one secret field, the admin api key', () => {
    const fields = getPlugin('ghost').credentialFields;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe('admin_api_key');
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.example).toContain('id:secret');
  });

  it('every declared field name is accepted by the credential schema', () => {
    // A field the schema rejects would make add_site write a config that
    // loadSites then refuses — the exact whole-file brick this guards against.
    for (const id of PLATFORM_IDS) {
      const plugin = getPlugin(id);
      const block: Record<string, unknown> = { platform: id, url: 'https://e.example.com' };
      for (const f of plugin.credentialFields) block[f.name] = f.secret ? '${X}' : 'literal';
      expect(plugin.credentialSchema.safeParse(block).success).toBe(true);
    }
  });
});
