import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  collectCredentialValues,
  collectProviderKeys,
  collectSite,
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
  const prompter: Prompter = {
    async text(o) {
      asked.push(o.message);
      if (o.secret) secretPrompts.push(o.message);
      return answers.shift() ?? null;
    },
    async choose(o) {
      asked.push(o.message);
      return (choices.shift() ?? null) as never;
    },
    note: (t) => void notes.push(t),
    problem: (t) => void problems.push(t),
  };
  return { prompter, asked, problems, notes, secretPrompts };
}

const okProbe = async (): Promise<HealthResult> => ({
  slug: 's',
  platform: 'p',
  ok: true,
  status: 200,
  detail: 'My Blog (Ghost 6.44)',
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
