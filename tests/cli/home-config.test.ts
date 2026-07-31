import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resolvePaths } from '../../src/config/paths.js';
import { parseEnv } from '../../src/config/dotenv.js';
import {
  ensureHome,
  envVarNameFor,
  removeEnvVars,
  seedPersonaTemplate,
  upsertEnvVars,
  writeSiteToConfig,
} from '../../src/cli/home-config.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wb-cfg-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const paths = () => resolvePaths({ BYLINE_HOME: home }, '/nowhere', '/nowhere');

describe('envVarNameFor', () => {
  it('derives an upper-snake name from the slug and field', () => {
    expect(envVarNameFor('personal', 'admin_api_key')).toBe('PERSONAL_ADMIN_API_KEY');
  });

  it('turns hyphens into underscores so the name is a valid env var', () => {
    expect(envVarNameFor('my-blog', 'app_password')).toBe('MY_BLOG_APP_PASSWORD');
  });

  it('drops any character that cannot appear in an env var name', () => {
    expect(envVarNameFor('blog.example', 'app password!')).toBe('BLOGEXAMPLE_APP_PASSWORD');
  });

  it('always produces a name resolveEnv can match', () => {
    // src/config/sites.ts's ENV_REF only matches ${[A-Z0-9_]+}. A name outside
    // that set silently falls through as a LITERAL credential, so the site
    // loads "usable" with garbage and fails later at publish time instead.
    expect(envVarNameFor('a-b.c', 'x y')).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe('ensureHome', () => {
  it('creates the home, personas, and runs directories', () => {
    ensureHome(paths());
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, 'personas'))).toBe(true);
    expect(existsSync(join(home, 'runs'))).toBe(true);
  });

  it('is safe to run twice', () => {
    ensureHome(paths());
    expect(() => ensureHome(paths())).not.toThrow();
  });
});

describe('upsertEnvVars', () => {
  it('creates .env at mode 600', () => {
    const file = join(home, '.env');
    upsertEnvVars(file, { PERSONAL_GHOST_KEY: 'id:secret' });
    expect(readFileSync(file, 'utf8')).toContain('PERSONAL_GHOST_KEY=id:secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing key in place rather than appending a duplicate', () => {
    const file = join(home, '.env');
    writeFileSync(file, '# keep me\nPERSONAL_GHOST_KEY=old\nOTHER=untouched\n');
    upsertEnvVars(file, { PERSONAL_GHOST_KEY: 'new' });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('OTHER=untouched');
    expect(text).toContain('PERSONAL_GHOST_KEY=new');
    expect(text).not.toContain('PERSONAL_GHOST_KEY=old');
    expect(text.match(/PERSONAL_GHOST_KEY=/g)).toHaveLength(1);
  });

  it('quotes a value containing spaces, so a WordPress app password round-trips', () => {
    const file = join(home, '.env');
    upsertEnvVars(file, { WP_APP_PASSWORD: 'abcd EFGH ijkl MNOP' });
    expect(readFileSync(file, 'utf8')).toContain('WP_APP_PASSWORD="abcd EFGH ijkl MNOP"');
  });

  it('tightens the mode of an existing loose .env', () => {
    const file = join(home, '.env');
    writeFileSync(file, 'A=1\n', { mode: 0o644 });
    upsertEnvVars(file, { B: '2' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('collapses a pre-existing duplicate key so parseEnv sees the new value', () => {
    // parseEnv resolves a duplicated key by taking the LAST occurrence. If
    // upsertEnvVars only rewrote the first match, the update would be a
    // silent no-op: the file looks edited, but the credential in effect
    // never changes.
    const file = join(home, '.env');
    writeFileSync(file, 'export  FOO = bar1\nFOO=bar2\n  FOO=bar3\n');
    upsertEnvVars(file, { FOO: 'newval' });
    const text = readFileSync(file, 'utf8');
    expect(text.match(/FOO/g)).toHaveLength(1);
    expect(parseEnv(text).FOO).toBe('newval');
  });

  it('does not throw when a key contains regex metacharacters', () => {
    // parseEnv itself only accepts [A-Za-z_][A-Za-z0-9_]* as a key, so a key
    // like this can never be read back — the point of this test is only that
    // the RegExp built from the key doesn't crash the caller.
    const file = join(home, '.env');
    expect(() => upsertEnvVars(file, { 'FOO(BAR': 'x' })).not.toThrow();
    expect(readFileSync(file, 'utf8')).toContain('FOO(BAR=x');
  });

  it('round-trips values with spaces, a hash, quotes, and a trailing space through parseEnv', () => {
    const file = join(home, '.env');
    const cases: Record<string, string> = {
      SPACES: 'abcd EFGH ijkl MNOP',
      HASH_VAL: 'value #withhash',
      DOUBLE_QUOTE_VAL: 'He said "hi" to me',
      SINGLE_QUOTE_VAL: "it's here",
      TRAILING_SPACE_VAL: 'trailing space ',
    };
    upsertEnvVars(file, cases);
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(cases)) {
      expect(parsed[key]).toBe(value);
    }
  });
});

describe('removeEnvVars', () => {
  it('deletes the named variables and leaves every other line alone', () => {
    const file = join(home, '.env');
    writeFileSync(file, '# my keys\nGEMINI_API_KEY=abc\n\nXAI_API_KEY=def\nMYBLOG_ADMIN_API_KEY=id:secret\n');
    expect(removeEnvVars(file, ['GEMINI_API_KEY'])).toEqual(['GEMINI_API_KEY']);
    const text = readFileSync(file, 'utf8');
    expect(parseEnv(text).GEMINI_API_KEY).toBeUndefined();
    expect(parseEnv(text).XAI_API_KEY).toBe('def');
    expect(parseEnv(text).MYBLOG_ADMIN_API_KEY).toBe('id:secret');
    expect(text).toContain('# my keys');
  });

  it('removes EVERY definition, not just the first', () => {
    // `parseEnv` takes the LAST occurrence, so removing only the first would
    // leave the variable still set while reporting a removal — the same trap
    // `upsertEnvVars` collapses duplicates for.
    const file = join(home, '.env');
    writeFileSync(file, 'GEMINI_API_KEY=old\nOTHER=keep\nexport GEMINI_API_KEY=newer\n');
    removeEnvVars(file, ['GEMINI_API_KEY']);
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    expect(parsed.GEMINI_API_KEY).toBeUndefined();
    expect(parsed.OTHER).toBe('keep');
  });

  it('reports nothing removed for a variable that was not there', () => {
    const file = join(home, '.env');
    writeFileSync(file, 'OTHER=keep\n');
    expect(removeEnvVars(file, ['NEVER_SET'])).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('OTHER=keep\n');
  });

  it('never creates a .env that does not exist', () => {
    // `init` must not bring the config home into being as a side effect of a
    // step that only removes something (Finding 2).
    const file = join(home, 'nested', '.env');
    expect(removeEnvVars(file, ['GEMINI_API_KEY'])).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves the file at mode 600', () => {
    const file = join(home, '.env');
    writeFileSync(file, 'GEMINI_API_KEY=abc\nOTHER=keep\n', { mode: 0o644 });
    removeEnvVars(file, ['GEMINI_API_KEY']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('writeSiteToConfig', () => {
  it('creates config.yaml with the site and sets it as the default', () => {
    const file = join(home, 'config.yaml');
    writeSiteToConfig(file, 'personal', { platform: 'ghost', url: 'https://x.com' }, true);
    const parsed = parse(readFileSync(file, 'utf8')) as { default_site: string; sites: Record<string, unknown> };
    expect(parsed.default_site).toBe('personal');
    expect(parsed.sites.personal).toEqual({ platform: 'ghost', url: 'https://x.com' });
  });

  it('adds a second site without disturbing the first or the default', () => {
    const file = join(home, 'config.yaml');
    writeSiteToConfig(file, 'a', { platform: 'ghost', url: 'https://a.com' }, true);
    writeSiteToConfig(file, 'b', { platform: 'wordpress', url: 'https://b.com' }, false);
    const parsed = parse(readFileSync(file, 'utf8')) as { default_site: string; sites: Record<string, unknown> };
    expect(parsed.default_site).toBe('a');
    expect(Object.keys(parsed.sites)).toEqual(['a', 'b']);
  });

  // Finding 1: this used to replace an existing slug unconditionally — the
  // other writer of this same file, `add_site` in src/tools/site-tools.ts, has
  // always refused exactly this with SITE_EXISTS. Reproduced: a site named
  // "personal" (Ghost, https://a.com) got silently overwritten by a WordPress
  // site at a different URL, including the .env secret persistSite had
  // already written for it — no warning, no recovery.
  it('refuses to silently replace an existing slug', () => {
    const file = join(home, 'config.yaml');
    writeSiteToConfig(file, 'personal', { platform: 'ghost', url: 'https://a.com' }, true);
    expect(() =>
      writeSiteToConfig(file, 'personal', { platform: 'wordpress', url: 'https://different.example.com' }, false),
    ).toThrow(/already exists/);

    // The original site must survive the refused write untouched.
    const parsed = parse(readFileSync(file, 'utf8')) as { sites: Record<string, unknown> };
    expect(parsed.sites.personal).toEqual({ platform: 'ghost', url: 'https://a.com' });
  });

  it('replaces an existing slug only when the caller opts in explicitly', () => {
    const file = join(home, 'config.yaml');
    writeSiteToConfig(file, 'personal', { platform: 'ghost', url: 'https://a.com' }, true);
    writeSiteToConfig(
      file,
      'personal',
      { platform: 'wordpress', url: 'https://b.com' },
      false,
      { replace: true },
    );
    const parsed = parse(readFileSync(file, 'utf8')) as { sites: Record<string, unknown> };
    expect(parsed.sites.personal).toEqual({ platform: 'wordpress', url: 'https://b.com' });
  });

  it('keeps hand-set keys a replace does not carry, so an update cannot silently delete api_url', () => {
    // `buildSiteBlock` composes only platform, url, and the credential fields
    // the plugin declares. A straight substitution would therefore drop an
    // `api_url` set by hand — many installs serve the admin API on another
    // host — while the user was updating something else entirely.
    const file = join(home, 'config.yaml');
    writeSiteToConfig(
      file,
      'personal',
      { platform: 'ghost', url: 'https://a.com', api_url: 'https://admin.a.com/ghost/api/admin' },
      true,
    );
    writeSiteToConfig(file, 'personal', { platform: 'ghost', url: 'https://b.com' }, false, { replace: true });
    const parsed = parse(readFileSync(file, 'utf8')) as { sites: Record<string, Record<string, string>> };
    expect(parsed.sites.personal).toEqual({
      platform: 'ghost',
      url: 'https://b.com',
      api_url: 'https://admin.a.com/ghost/api/admin',
    });
  });

  // Finding 1's related default-site bug: a newly added blog must only become
  // the default when none exists yet — never because a caller passed
  // `makeDefault: true` for reasons unrelated to whether a default already
  // exists (e.g. `init`'s old `added.length === 0`, which stole `default_site`
  // from an already-migrated site the moment a session added its first new
  // blog, even though that blog's slug was never in conflict).
  it('does not let makeDefault steal default_site from an already-configured site', () => {
    const file = join(home, 'config.yaml');
    // Simulates a migrated config: a default already exists before this
    // session's loop runs.
    writeSiteToConfig(file, 'existing', { platform: 'ghost', url: 'https://a.com' }, true);
    // This is exactly the call `runInit` now makes for every blog its loop
    // adds — `makeDefault` is always `false`, relying on the `!doc.default_site`
    // fallback below to cover "first site ever" instead.
    writeSiteToConfig(file, 'new-blog', { platform: 'ghost', url: 'https://b.com' }, false);
    const parsed = parse(readFileSync(file, 'utf8')) as { default_site: string };
    expect(parsed.default_site).toBe('existing');
  });
});

describe('seedPersonaTemplate', () => {
  it('copies the shipped template into the personas directory', () => {
    const dir = join(home, 'personas');
    const written = seedPersonaTemplate(dir);
    expect(written).toBe(join(dir, '_template.yaml'));
    expect(readFileSync(written!, 'utf8').length).toBeGreaterThan(0);
  });

  it('never overwrites a template the user has already edited', () => {
    const dir = join(home, 'personas');
    seedPersonaTemplate(dir);
    writeFileSync(join(dir, '_template.yaml'), 'edited by hand');
    expect(seedPersonaTemplate(dir)).toBeNull();
    expect(readFileSync(join(dir, '_template.yaml'), 'utf8')).toBe('edited by hand');
  });
});
