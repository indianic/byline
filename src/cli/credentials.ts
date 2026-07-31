import { cancel, isCancel, password, select, spinner, text } from '@clack/prompts';
import type { SiteConfig } from '../config/sites.js';
import type { CredentialField, HealthResult, PlatformPlugin } from '../plugins/platforms/types.js';
import type { KeyedProvider, ProviderFamily } from '../plugins/provider.js';
import { fail, info } from './tree.js';

/**
 * The credential walk.
 *
 * Two rules shape everything here:
 *
 * 1. **Nothing platform-specific is written in this file.** Every prompt — its
 *    label, its placeholder, its "where do I find this?" click-path, and
 *    whether it is masked — comes from a `CredentialField` descriptor owned by
 *    the plugin. That is the entire point of the descriptor: a third platform
 *    gets a correct installer flow by declaring its fields, with no edit here.
 *    Image providers declare the same shape, so one walk serves both.
 *
 * 2. **A credential is never accepted until it has been proven to work.** Each
 *    value is probed against the real API at entry and the platform's own error
 *    is shown on failure. This codebase has now been bitten six times by
 *    something that typechecked, built, passed its tests, and did nothing —
 *    a key that "looks right" is worth nothing.
 *
 * Prompting is injected via `Prompter` so both rules are unit-testable without
 * a terminal or a network.
 */

export interface Prompter {
  /** Returns null when the user skips. `secret: true` masks the input. */
  text(o: { message: string; placeholder?: string; secret?: boolean }): Promise<string | null>;
  choose<T extends string>(o: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
  }): Promise<T | null>;
  /** Guidance shown before a prompt — the descriptor's `help`. */
  note(text: string): void;
  /** A failure the user has to react to — the platform's real error. */
  problem(text: string): void;
}

export interface CollectedSite {
  slug: string;
  platform: string;
  url: string;
  /** Raw values keyed by credential field name. Secrets are the VALUE, not an env var name. */
  values: Record<string, string>;
  defaultAuthor?: string;
}

export type SiteProbe = (site: SiteConfig) => Promise<HealthResult>;
export type ProviderProbe = (provider: KeyedProvider, key: string) => Promise<{ ok: boolean; detail: string }>;

/**
 * Ask for every declared field, in the order the plugin lists them.
 *
 * Returns null as soon as ANY prompt is skipped: a half-entered site cannot
 * authenticate, so recording it would produce a config that loads "usable" and
 * fails at publish time — the failure mode the whole setup gate exists to
 * avoid. Skipping means "not this site", and the caller moves on.
 */
export async function collectCredentialValues(
  fields: readonly CredentialField[],
  p: Prompter,
): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {};

  for (const f of fields) {
    // A masked prompt can never show a placeholder — @clack's `password()` has
    // no such parameter and its renderer only reads the hidden value — so the
    // descriptor's `example` (Ghost's `id:secret` vs WordPress's
    // `xxxx xxxx xxxx xxxx xxxx xxxx`) has to ride on the note printed just
    // before the prompt, or a secret field never shows it at all.
    p.note(f.secret && f.example ? `${f.label} — ${f.help} (looks like: ${f.example})` : `${f.label} — ${f.help}`);
    const answer = await p.text({
      message: `${f.label} (Enter nothing to skip)`,
      placeholder: f.example,
      secret: f.secret,
    });
    if (answer === null || answer.trim() === '') return null;
    values[f.name] = answer.trim();
  }

  return values;
}

/**
 * Collect one site's credentials and prove them against the live API.
 *
 * The probed `SiteConfig` is built in memory with RESOLVED values — nothing has
 * been written to disk yet, and a `${ENV_VAR}` reference would not
 * authenticate. `unavailable` is deliberately absent: the whole point is to
 * find out whether these credentials work.
 */
export async function collectSite(
  plugin: PlatformPlugin,
  slug: string,
  url: string,
  p: Prompter,
  probe: SiteProbe,
): Promise<CollectedSite | null> {
  for (;;) {
    const values = await collectCredentialValues(plugin.credentialFields, p);
    if (!values) return null;

    const candidate: SiteConfig = {
      slug,
      platform: plugin.id,
      url: url.replace(/\/+$/, ''),
      apiUrl: plugin.defaultApiUrl(url),
      credentials: values,
    };

    const health = await probe(candidate);
    if (health.ok) {
      return { slug, platform: plugin.id, url: candidate.url, values };
    }

    p.problem(
      `${plugin.label} rejected these credentials${health.status ? ` (HTTP ${health.status})` : ''}:\n${health.detail}`,
    );

    const next = await p.choose({
      message: 'What now?',
      options: [
        { value: 'retry', label: 'Try again', hint: 're-enter the credentials' },
        { value: 'skip', label: 'Skip this site', hint: 'add it later with `byline init`' },
      ],
    });
    if (next !== 'retry') return null;
  }
}

/**
 * Ask for every provider key in every family the caller offers, keyed by the
 * env var each provider declares.
 *
 * Nothing here knows what a family DOES. The yes/no question, the section
 * label, and each prompt's text all come off descriptors, which is what keeps
 * `src/cli/` free of provider identities — a research family appears in the
 * installer for free, correctly or incorrectly, exactly as it describes itself.
 *
 * Skipping one provider still asks about the next: within a family the second
 * provider may be a fallback (images) or an alternative (research), and plenty
 * of users want only the first either way.
 */
export async function collectProviderKeys(
  families: readonly ProviderFamily[],
  p: Prompter,
  probe: ProviderProbe,
  ask: (question: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};

  for (const family of families) {
    if (!(await ask(family.initPrompt))) continue;

    for (const provider of family.providers({})) {
      for (;;) {
        const c = provider.credential;
        p.note(c.secret && c.example ? `${c.label} — ${c.help} (looks like: ${c.example})` : `${c.label} — ${c.help}`);
        const answer = await p.text({
          message: `${c.label} (Enter nothing to skip)`,
          placeholder: c.example,
          secret: c.secret,
        });
        if (answer === null || answer.trim() === '') break;

        const result = await probe(provider, answer.trim());
        if (result.ok) {
          keys[c.name] = answer.trim();
          break;
        }

        p.problem(`${provider.name} rejected that key:\n${result.detail}`);
        const next = await p.choose({
          message: 'What now?',
          options: [
            { value: 'retry', label: 'Try again' },
            { value: 'skip', label: `Skip ${provider.name}` },
          ],
        });
        if (next !== 'retry') break;
      }
    }
  }

  return keys;
}

/** The real network probe used by `init`. Spins while the request is in flight. */
export const liveProbe: SiteProbe = async (site) => {
  const { makeAdapter } = await import('../plugins/registry.js');
  const s = spinner();
  s.start(`Checking ${site.url}`);
  try {
    const health = await makeAdapter(site).healthCheck();
    s.stop(health.ok ? `Connected to ${site.url} — ${health.detail}` : `Could not connect to ${site.url}`);
    return health;
  } catch (e) {
    s.stop(`Could not connect to ${site.url}`);
    return {
      slug: site.slug,
      platform: site.platform,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
};

/** The real provider probe. Re-instantiates the provider with the candidate key. */
export const liveProviderProbe: ProviderProbe = async (provider, key) => {
  const s = spinner();
  s.start(`Checking ${provider.name}`);
  try {
    // `withKey`, not `provider.constructor as new (apiKey: string) => …`:
    // that cast typechecked unconditionally, asserting a constructor shape
    // nothing declared. A provider without a single-string constructor would
    // have thrown here at runtime, inside init, mid-prompt. The interface now
    // declares how to rebind a key, so such a provider fails to compile.
    const health = await provider.withKey(key).healthCheck();
    s.stop(health.ok ? `${provider.name} key works` : `${provider.name} rejected the key`);
    return { ok: health.ok, detail: health.detail };
  } catch (e) {
    s.stop(`${provider.name} check failed`);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

/** The @clack-backed Prompter used by `init`. Cancel (Ctrl-C) exits; empty input skips. */
export const clackPrompter: Prompter = {
  async text(o) {
    const answer = o.secret
      ? await password({ message: o.message })
      : await text({ message: o.message, placeholder: o.placeholder });
    if (isCancel(answer)) {
      cancel('Cancelled.');
      process.exit(1);
    }
    const value = String(answer ?? '').trim();
    return value === '' ? null : value;
  },
  async choose(o) {
    const chosen = await select({ message: o.message, options: o.options });
    if (isCancel(chosen)) {
      cancel('Cancelled.');
      process.exit(1);
    }
    return chosen as never;
  },
  note: (t) => info(t),
  problem: (t) => fail(t),
};
