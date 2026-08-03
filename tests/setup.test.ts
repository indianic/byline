import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext } from '../src/context.js';
import { requireSetup } from '../src/setup.js';
import { ToolError } from '../src/errors.js';

/** A context pointed at an empty directory — the brand-new-user state. */
function emptyContext() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-empty-'));
  return loadContext({ BYLINE_HOME: dir });
}

describe('loadContext with no configuration', () => {
  it('does not throw', () => {
    expect(() => emptyContext()).not.toThrow();
  });

  it('reports itself unconfigured with zero sites', () => {
    const ctx = emptyContext();
    expect(ctx.setup.configured).toBe(false);
    expect(ctx.setup.siteCount).toBe(0);
    expect(ctx.setup.usableSiteCount).toBe(0);
  });

  it('records why, so doctor can explain it', () => {
    const ctx = emptyContext();
    expect(ctx.setup.problems.length).toBeGreaterThan(0);
    expect(ctx.setup.problems.join(' ')).toMatch(/config/i);
  });
});

describe('requireSetup', () => {
  it('throws SETUP_INCOMPLETE naming the fix when no sites exist', () => {
    const ctx = emptyContext();
    try {
      requireSetup(ctx, 'sites');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe('SETUP_INCOMPLETE');
      expect(err.message).toContain('No sites');
      expect(err.hint).toContain('init');
    }
  });

  it('throws for personas when none are configured', () => {
    const ctx = emptyContext();
    expect(() => requireSetup(ctx, 'personas')).toThrow(ToolError);
  });

  it('throws for images when no provider key is set', () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-img-')) });
    expect(() => requireSetup(ctx, 'images')).toThrow(/image/i);
  });

  it('distinguishes "no sites at all" from "a site whose key is unset"', () => {
    // Both are SETUP_INCOMPLETE, but the message must name the actual gap so the
    // user is not sent to re-run init when the real fix is one env var.
    const ctx = emptyContext();
    const noSites = (() => {
      try { requireSetup(ctx, 'sites'); return ''; }
      catch (e) { return (e as ToolError).message; }
    })();
    expect(noSites).toContain('No sites');
    expect(noSites).not.toContain('environment variable');
  });

  it('names the missing env var without leaking an unrelated persona parse error', () => {
    // Reproduces a reviewer-found defect: a site with an unset env var plus a
    // persona file with malformed YAML used to dump the YAML parser's caret
    // diagnostic into a message that is supposed to be about sites.
    const dir = mkdtempSync(join(tmpdir(), 'wb-scoped-'));
    writeFileSync(
      join(dir, 'config.yaml'),
      [
        'sites:',
        '  personal:',
        '    platform: ghost',
        '    url: https://blog.example.com',
        '    admin_api_key: ${MISSING_KEY_VAR}',
        '',
      ].join('\n'),
    );
    const personasDir = join(dir, 'personas');
    mkdirSync(personasDir);
    writeFileSync(join(personasDir, 'broken.yaml'), 'slug: [unterminated\n');

    const env = { BYLINE_HOME: dir } as NodeJS.ProcessEnv;
    delete env.MISSING_KEY_VAR;
    const ctx = loadContext(env);

    let message = '';
    try {
      requireSetup(ctx, 'sites');
      expect.unreachable('should have thrown');
    } catch (e) {
      message = (e as ToolError).message;
    }

    expect(message).toContain('MISSING_KEY_VAR');
    expect(message).not.toContain('flow sequence');
    expect(message).not.toContain('unterminated');
  });
});
