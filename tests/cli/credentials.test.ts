import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  collectCredentialValues,
  collectProviderKeys,
  collectSite,
  maskSecret,
  type Prompter,
} from '../../src/cli/credentials.js';
import { ghostPlugin } from '../../src/plugins/platforms/ghost/plugin.js';
import { wordpressPlugin } from '../../src/plugins/platforms/wordpress/plugin.js';
import type { HealthResult, PlatformPlugin } from '../../src/plugins/platforms/types.js';
import type { SiteConfig } from '../../src/config/sites.js';
import type { KeyedProvider, ProviderFamily } from '../../src/plugins/provider.js';

/** A Prompter that replays scripted answers and records what it was asked. */
function scripted(answers: Array<string | null>, choices: Array<string | null> = []) {
  const asked: string[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const secretPrompts: string[] = [];
  /** Every `choose` call's option values, in order — how "keep is first" is asserted. */
  const offered: string[][] = [];
  const prompter: Prompter = {
    async text(o) {
      asked.push(o.message);
      if (o.secret) secretPrompts.push(o.message);
      return answers.shift() ?? null;
    },
    async choose(o) {
      asked.push(o.message);
      offered.push(o.options.map((option) => option.value));
      return (choices.shift() ?? null) as never;
    },
    note: (t) => void notes.push(t),
    problem: (t) => void problems.push(t),
  };
  /** Everything this prompter ever put in front of the user, joined. */
  const printed = () => [...asked, ...notes, ...problems].join('\n');
  return { prompter, asked, problems, notes, secretPrompts, offered, printed };
}

const okProbe = async (): Promise<HealthResult> => ({
  slug: 's',
  platform: 'p',
  ok: true,
  status: 200,
  detail: 'My Blog (Ghost 6.44)',
});

describe('maskSecret', () => {
  it('shows the first and last four characters and nothing in between', () => {
    const masked = maskSecret('sk-live-0123456789abcdef');
    expect(masked).toContain('sk-l');
    expect(masked).toContain('cdef');
    expect(masked).not.toContain('0123456789ab');
  });

  it('never contains the whole value, for any length worth masking', () => {
    for (const secret of ['abcdefghi', 'sk-1234567890', '0'.repeat(24) + ':' + 'a'.repeat(64)]) {
      expect(maskSecret(secret)).not.toContain(secret);
    }
  });

  it('reveals nothing at all when four-and-four would be most of the value', () => {
    const masked = maskSecret('short');
    expect(masked).not.toContain('shor');
    expect(masked).not.toContain('hort');
    expect(masked).toContain('5 characters');
  });
});

describe('collectCredentialValues', () => {
  it('asks for every field the plugin declares, in order, using its labels', async () => {
    const { prompter, asked } = scripted(['editor', 'abcd EFGH ijkl MNOP']);
    const values = await collectCredentialValues(wordpressPlugin.credentialFields, prompter);
    expect(values).toEqual({ username: 'editor', app_password: 'abcd EFGH ijkl MNOP' });
    expect(asked[0]).toContain('WordPress username');
    expect(asked[1]).toContain('Application Password');
  });

  it('masks secret fields and does not mask non-secret ones', async () => {
    const { prompter, secretPrompts } = scripted(['editor', 'pw']);
    await collectCredentialValues(wordpressPlugin.credentialFields, prompter);
    expect(secretPrompts).toHaveLength(1);
    expect(secretPrompts[0]).toContain('Application Password');
  });

  it('prints the descriptor help so the user can actually find the credential', async () => {
    const { prompter, notes } = scripted(['id:secret']);
    await collectCredentialValues(ghostPlugin.credentialFields, prompter);
    expect(notes.join('\n')).toContain('Settings → Integrations');
  });

  it('shows a secret field’s example on the note, since a masked prompt can never show a placeholder', async () => {
    // @clack/prompts' password() has no placeholder param and its renderer only
    // reads the masked value, so the descriptor's `example` — what distinguishes
    // Ghost's Admin key from its look-alike Content key — has to reach the user
    // through the note printed just before the prompt, or nowhere at all.
    const { prompter, notes } = scripted(['id:secret']);
    await collectCredentialValues(ghostPlugin.credentialFields, prompter);
    expect(notes.join('\n')).toContain('id:secret');
  });

  it('does not append an example to a non-secret field’s note (it already gets a real placeholder)', async () => {
    const { prompter, notes } = scripted(['editor', 'abcd EFGH ijkl MNOP']);
    await collectCredentialValues(wordpressPlugin.credentialFields, prompter);
    const usernameNote = notes.find((n) => n.includes('WordPress username'));
    expect(usernameNote).toBeDefined();
    expect(usernameNote).not.toContain('editor');
  });

  it('returns null the moment any prompt is skipped', async () => {
    const { prompter } = scripted(['editor', null]);
    expect(await collectCredentialValues(wordpressPlugin.credentialFields, prompter)).toBeNull();
  });

  // --- Re-run: updating a site that is already configured ---
  //
  // The rule these guard: an empty answer means "keep" ONLY where there is a
  // stored value to keep. Everywhere else it still means "skip", and skipping
  // still abandons the walk. The two meanings share a function and must not
  // share a field.

  it('keeps a field on an empty answer and replaces the one that was retyped', async () => {
    const { prompter } = scripted([null, 'new-pass']);
    const values = await collectCredentialValues(wordpressPlugin.credentialFields, prompter, {
      username: 'editor',
      app_password: 'old-pass',
    });
    expect(values).toEqual({ username: 'editor', app_password: 'new-pass' });
  });

  it('keeps every field when the user presses Enter through all of them', async () => {
    const { prompter } = scripted([null, null]);
    const values = await collectCredentialValues(wordpressPlugin.credentialFields, prompter, {
      username: 'editor',
      app_password: 'old-pass',
    });
    expect(values).toEqual({ username: 'editor', app_password: 'old-pass' });
  });

  it('shows a stored non-secret in full but a stored secret only as a fingerprint', async () => {
    const { prompter, printed } = scripted([null, null]);
    await collectCredentialValues(wordpressPlugin.credentialFields, prompter, {
      username: 'editor',
      app_password: 'abcdEFGHijklMNOP',
    });
    expect(printed()).toContain('editor');
    // The load-bearing half: the secret must be identifiable, never readable.
    expect(printed()).not.toContain('abcdEFGHijklMNOP');
    expect(printed()).toContain('abcd');
    expect(printed()).toContain('MNOP');
  });

  it('never offers a stored secret as a placeholder either — only the descriptor example', async () => {
    const placeholders: Array<string | undefined> = [];
    const prompter: Prompter = {
      text: async (o) => {
        placeholders.push(o.placeholder);
        return null;
      },
      choose: async () => null,
      note: () => {},
      problem: () => {},
    };
    await collectCredentialValues(wordpressPlugin.credentialFields, prompter, {
      username: 'editor',
      app_password: 'abcdEFGHijklMNOP',
    });
    expect(placeholders).not.toContain('abcdEFGHijklMNOP');
  });

  it('still abandons during an update when a field has NO stored value and is skipped', async () => {
    // A site whose ${VAR} is unset loads with an empty credential. There is
    // nothing to keep, so this field is asked as new — and skipping it must
    // abandon exactly as it would for a brand-new site, rather than recording
    // a blank credential that loads "usable" and fails at publish time.
    const { prompter } = scripted([null]);
    const values = await collectCredentialValues(wordpressPlugin.credentialFields, prompter, {
      username: '',
      app_password: 'stored',
    });
    expect(values).toBeNull();
  });

  it('is driven entirely by the descriptor — a made-up platform gets prompts for free', async () => {
    // The real guarantee: nothing about Ghost or WordPress is hardcoded here.
    const invented: PlatformPlugin = {
      ...ghostPlugin,
      id: 'invented',
      label: 'Invented',
      credentialSchema: z.object({}),
      credentialFields: [
        { name: 'tenant', label: 'Tenant id', secret: false, example: 't-123', help: 'Somewhere in the dashboard.' },
        { name: 'token', label: 'Bearer token', secret: true, example: 'tok_…', help: 'Settings, then API tokens.' },
      ],
    };
    const { prompter, asked, secretPrompts } = scripted(['t-1', 'tok_x']);
    expect(await collectCredentialValues(invented.credentialFields, prompter)).toEqual({
      tenant: 't-1',
      token: 'tok_x',
    });
    expect(asked[0]).toContain('Tenant id');
    expect(secretPrompts[0]).toContain('Bearer token');
  });
});

describe('collectSite', () => {
  it('validates the credentials live and returns the site when the probe passes', async () => {
    const { prompter } = scripted(['id:secret']);
    const probe = vi.fn(okProbe);
    const site = await collectSite(ghostPlugin, 'personal', 'https://blog.example.com', prompter, probe);
    expect(site).toEqual({
      slug: 'personal',
      platform: 'ghost',
      url: 'https://blog.example.com',
      values: { admin_api_key: 'id:secret' },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    // The probe gets RESOLVED values, not ${ENV_VAR} references — nothing has
    // been written to disk yet, and a reference would not authenticate.
    const probed = probe.mock.calls[0]![0] as SiteConfig;
    expect(probed.credentials.admin_api_key).toBe('id:secret');
    expect(probed.apiUrl).toBe('https://blog.example.com/ghost/api/admin');
  });

  it('shows the real error and re-prompts, accepting only a key that works', async () => {
    const { prompter, problems } = scripted(['wrong', 'right'], ['retry']);
    let call = 0;
    const probe = async (): Promise<HealthResult> => {
      call += 1;
      return call === 1
        ? { slug: 's', platform: 'ghost', ok: false, status: 401, detail: 'Unknown Content API Key' }
        : { slug: 's', platform: 'ghost', ok: true, status: 200, detail: 'My Blog' };
    };
    const site = await collectSite(ghostPlugin, 'personal', 'https://x.com', prompter, probe);
    expect(site!.values.admin_api_key).toBe('right');
    // The platform's real message, not a generic "invalid key".
    expect(problems.join('\n')).toContain('Unknown Content API Key');
  });

  it('never returns a site whose credentials failed the live probe', async () => {
    const { prompter } = scripted(['wrong'], ['skip']);
    const probe = async (): Promise<HealthResult> => ({
      slug: 's',
      platform: 'ghost',
      ok: false,
      status: 401,
      detail: 'rejected',
    });
    expect(await collectSite(ghostPlugin, 'personal', 'https://x.com', prompter, probe)).toBeNull();
  });

  it('returns null when the credential walk itself is skipped, without probing', async () => {
    const { prompter } = scripted([null]);
    const probe = vi.fn(okProbe);
    expect(await collectSite(ghostPlugin, 'personal', 'https://x.com', prompter, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  // --- A NEW site's skip-abandons rule, unchanged by the update walk ---

  it('abandons a NEW site when a later field is skipped, and never probes', async () => {
    const { prompter } = scripted(['editor', null]);
    const probe = vi.fn(okProbe);
    expect(await collectSite(wordpressPlugin, 'wp', 'https://x.com', prompter, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('abandons a NEW site on a skipped field even on a RETRY after a failed probe', async () => {
    // The exact way the two meanings of "empty" could have leaked into each
    // other: the retry loop re-seeds itself from the last attempt so an update
    // can keep a correction. For a new site there is no seed, so the second
    // pass must still treat an empty answer as "skip" and abandon.
    //
    // The probe MUST succeed on the second call. If it failed every time (as
    // an earlier version of this test had it), `collectSite` returns null
    // either way — via the correct "skip abandons" branch on real code, or via
    // "the user declined to retry again" on a mutant that drops the `if
    // (current) seed = values;` guard (src/cli/credentials.ts) and lets a
    // failed attempt's values leak into `seed` for a NEW site. Both paths end
    // in `toBeNull()`, so that version passed whether or not the guard existed
    // — proven by mutation: removing the guard left this test (and all others
    // in this file) green. Succeeding on the second call is what forces the
    // two paths to diverge: on real code, `seed` stays `undefined` for a new
    // site, so the null answer on `app_password` returns null immediately and
    // the probe is never called a second time. On the mutant, the leaked seed
    // makes `app_password` a "kept" field, so a null answer there keeps the
    // OLD value instead of abandoning, the walk proceeds to a second probe,
    // that probe now succeeds, and `collectSite` wrongly returns a site.
    const { prompter } = scripted(['editor', 'pw', 'editor-again', null], ['retry']);
    let calls = 0;
    const probe = async (): Promise<HealthResult> => {
      calls++;
      return calls === 1
        ? { slug: 's', platform: 'wordpress', ok: false, status: 401, detail: 'rejected' }
        : { slug: 's', platform: 'wordpress', ok: true, status: 200, detail: 'accepted' };
    };
    expect(await collectSite(wordpressPlugin, 'wp', 'https://x.com', prompter, probe)).toBeNull();
    // The walk must abandon BEFORE reaching the second probe at all — proof
    // that the null answer on `app_password` was treated as "skip", not
    // "keep the value from the failed first attempt".
    expect(calls).toBe(1);
  });

  // --- Updating a site that is already configured ---

  it('probes a KEPT credential rather than accepting it unchecked', async () => {
    // `init`'s whole promise is that nothing it writes went unverified. A key
    // the user did not retype is still a key that may have been revoked since.
    const { prompter, secretPrompts } = scripted([null]);
    const probe = vi.fn(okProbe);
    const site = await collectSite(
      ghostPlugin,
      'personal',
      'https://blog.example.com',
      prompter,
      probe,
      { admin_api_key: 'stored:key' },
    );
    expect(site!.values.admin_api_key).toBe('stored:key');
    expect(probe).toHaveBeenCalledTimes(1);
    expect((probe.mock.calls[0]![0] as SiteConfig).credentials.admin_api_key).toBe('stored:key');
    // And it did so without making the user type the key out again.
    expect(secretPrompts.map((m) => m)).toEqual([expect.stringContaining('Enter to keep')]);
  });

  it('changes only the field the user actually retyped', async () => {
    const { prompter } = scripted([null, 'new-pass']);
    const site = await collectSite(wordpressPlugin, 'wp', 'https://x.com', prompter, okProbe, {
      username: 'editor',
      app_password: 'old-pass',
    });
    expect(site!.values).toEqual({ username: 'editor', app_password: 'new-pass' });
  });

  it('never returns an updated site whose merged credentials failed the probe', async () => {
    const { prompter } = scripted([null], ['skip']);
    const probe = async (): Promise<HealthResult> => ({
      slug: 's',
      platform: 'ghost',
      ok: false,
      status: 401,
      detail: 'Key revoked',
    });
    const site = await collectSite(ghostPlugin, 'p', 'https://x.com', prompter, probe, {
      admin_api_key: 'stale:key',
    });
    expect(site).toBeNull();
  });

  it('tells the user a kept credential was rejected, in the platform’s own words', async () => {
    const { prompter, problems } = scripted([null], ['skip']);
    const probe = async (): Promise<HealthResult> => ({
      slug: 's',
      platform: 'ghost',
      ok: false,
      status: 401,
      detail: 'Unknown Admin API Key',
    });
    await collectSite(ghostPlugin, 'p', 'https://x.com', prompter, probe, { admin_api_key: 'stale:key' });
    expect(problems.join('\n')).toContain('Unknown Admin API Key');
  });

  it('on a retry, Enter keeps the correction rather than reverting to the stored value', async () => {
    const { prompter } = scripted(['fixed:key', null], ['retry']);
    let call = 0;
    const probe = async (): Promise<HealthResult> => {
      call += 1;
      return call === 1
        ? { slug: 's', platform: 'ghost', ok: false, status: 401, detail: 'no' }
        : { slug: 's', platform: 'ghost', ok: true, status: 200, detail: 'My Blog' };
    };
    const site = await collectSite(ghostPlugin, 'p', 'https://x.com', prompter, probe, {
      admin_api_key: 'stale:key',
    });
    expect(site!.values.admin_api_key).toBe('fixed:key');
    expect(call).toBe(2);
  });
});

describe('collectProviderKeys', () => {
  // No `as KeyedProvider` cast: the cast used to hide whether this double
  // actually satisfies the interface, which is the entire point of a double.
  const provider = (name: string, envVar: string, key = ''): KeyedProvider => ({
    name,
    credential: { name: envVar, label: `${name} key`, secret: true, example: 'x', help: 'Somewhere in the console.' },
    configured: () => key.length > 0,
    withKey: (k: string) => provider(name, envVar, k),
    healthCheck: async () => ({ provider: name, ok: true, detail: 'ok' }),
  });

  // No `as ProviderFamily` cast either, for the same reason.
  const family = (providers: readonly KeyedProvider[], id: ProviderFamily['id'] = 'images'): ProviderFamily => ({
    id,
    label: `${id} family`,
    initPrompt: `Set up ${id}?`,
    unconfiguredNote: 'skipped',
    providers: () => providers,
  });

  const alwaysYes = async () => true;

  it('keys the result by each provider’s declared env var name', async () => {
    const { prompter } = scripted(['a-key', 'b-key']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY'), provider('beta', 'BETA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
    );
    expect(keys).toEqual({ ALPHA_API_KEY: 'a-key', BETA_API_KEY: 'b-key' });
  });

  it('skipping one provider still collects the next', async () => {
    const { prompter } = scripted([null, 'b-key']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY'), provider('beta', 'BETA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
    );
    expect(keys).toEqual({ BETA_API_KEY: 'b-key' });
  });

  it('does not keep a key the provider rejected', async () => {
    const { prompter, problems } = scripted(['bad'], ['skip']);
    const probe = async () => ({ ok: false, detail: 'API key not valid' });
    const keys = await collectProviderKeys([family([provider('alpha', 'ALPHA_API_KEY')])], prompter, probe, alwaysYes);
    expect(keys).toEqual({});
    expect(problems.join('\n')).toContain('API key not valid');
  });

  it('skips an entire family without prompting when ask() declines it', async () => {
    const { prompter, asked } = scripted([]);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      async () => false,
    );
    expect(keys).toEqual({});
    expect(asked).toHaveLength(0);
  });

  // --- Re-run: a key that is already in .env ---
  //
  // The reported failure: `init` asked for every provider key again, with no
  // way to say "keep what I have". These fix the shape of the answer.

  const STORED = 'sk-live-0123456789abcdef';

  it('never asks a configured provider to retype its key, and writes nothing for a kept one', async () => {
    const { prompter, secretPrompts } = scripted([], ['keep']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    // Nothing to write: the value is already in .env under this exact name.
    expect(keys).toEqual({});
    expect(secretPrompts).toEqual([]);
  });

  it('keeps the stored key when the user just presses Enter through the menu', async () => {
    // @clack's select confirms the HIGHLIGHTED option and the first starts
    // highlighted, so "keep" must be offered first. The double returns null
    // for an unscripted choose, which is the same no-op path.
    const { prompter, offered } = scripted([], []);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({});
    expect(offered[0]![0]).toBe('keep');
  });

  it('probes the stored key even when it is kept — a revoked key must not pass as configured', async () => {
    const { prompter } = scripted([], ['keep']);
    const probed: string[] = [];
    const probe = async (_p: KeyedProvider, key: string) => {
      probed.push(key);
      return { ok: true, detail: 'reachable' };
    };
    await collectProviderKeys([family([provider('alpha', 'ALPHA_API_KEY')])], prompter, probe, alwaysYes, {
      ALPHA_API_KEY: STORED,
    });
    expect(probed).toEqual([STORED]);
  });

  it('reports a kept key the provider no longer accepts, and takes the replacement', async () => {
    const { prompter, problems } = scripted(['replacement-key'], ['keep', 'replace']);
    const probe = async (_p: KeyedProvider, key: string) =>
      key === 'replacement-key' ? { ok: true, detail: 'reachable' } : { ok: false, detail: 'API key not valid' };
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({ ALPHA_API_KEY: 'replacement-key' });
    expect(problems.join('\n')).toContain('API key not valid');
  });

  it('offers replacement first when a kept key fails its probe', async () => {
    const { prompter, offered } = scripted([], ['keep', 'keep']);
    const probe = async () => ({ ok: false, detail: 'API key not valid' });
    await collectProviderKeys([family([provider('alpha', 'ALPHA_API_KEY')])], prompter, probe, alwaysYes, {
      ALPHA_API_KEY: STORED,
    });
    // The second menu is the one shown after the failure.
    expect(offered[1]![0]).toBe('replace');
  });

  it('leaves a failing stored key alone when the user says so, rather than deleting it', async () => {
    const { prompter } = scripted([], ['keep', 'keep']);
    const probe = async () => ({ ok: false, detail: 'API key not valid' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({});
  });

  it('records a removal as null, which is what deletes the variable from .env', async () => {
    const { prompter } = scripted([], ['remove']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({ ALPHA_API_KEY: null });
  });

  it('takes a replacement through the same live probe a new key faces', async () => {
    const { prompter, problems } = scripted(['bad-key', 'good-key'], ['replace', 'retry']);
    const probe = async (_p: KeyedProvider, key: string) =>
      key === 'good-key' ? { ok: true, detail: 'reachable' } : { ok: false, detail: 'API key not valid' };
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({ ALPHA_API_KEY: 'good-key' });
    expect(problems.join('\n')).toContain('API key not valid');
  });

  it('shows a fingerprint of the stored key and never the key itself', async () => {
    const { prompter, printed } = scripted([], ['keep']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    await collectProviderKeys([family([provider('alpha', 'ALPHA_API_KEY')])], prompter, probe, alwaysYes, {
      ALPHA_API_KEY: STORED,
    });
    expect(printed()).not.toContain(STORED);
    expect(printed()).toContain('sk-l');
    expect(printed()).toContain('cdef');
  });

  it('leaves a configured family completely untouched when its own question is declined', async () => {
    const { prompter, asked } = scripted([], []);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY')])],
      prompter,
      probe,
      async () => false,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({});
    expect(asked).toHaveLength(0);
  });

  it('still walks an unconfigured provider normally when its family-mate is configured', async () => {
    const { prompter } = scripted(['b-key'], ['keep']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [family([provider('alpha', 'ALPHA_API_KEY'), provider('beta', 'BETA_API_KEY')])],
      prompter,
      probe,
      alwaysYes,
      { ALPHA_API_KEY: STORED },
    );
    expect(keys).toEqual({ BETA_API_KEY: 'b-key' });
  });

  it('asks each family independently, so declining one still walks the next', async () => {
    const { prompter } = scripted(['b-key']);
    const probe = async () => ({ ok: true, detail: 'reachable' });
    const keys = await collectProviderKeys(
      [
        family([provider('alpha', 'ALPHA_API_KEY')], 'images'),
        family([provider('beta', 'BETA_API_KEY')], 'research'),
      ],
      prompter,
      probe,
      async (q) => q === 'Set up research?',
    );
    expect(keys).toEqual({ BETA_API_KEY: 'b-key' });
  });
});
