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
 * A fingerprint of a stored secret: enough to tell WHICH key this is, never
 * enough to use it.
 *
 * Re-running `init` has to show what is already configured, and a stored value
 * is the only thing that distinguishes "the Gemini key I made last week" from
 * "the one I rotated yesterday". Printing it would put a live credential into
 * a terminal's scrollback and into every screen recording of a setup walkthrough,
 * so only the first and last four characters ever appear. Values short enough
 * that four-and-four would be most of the string show nothing at all.
 *
 * Whether a value goes through here is decided by `CredentialField.secret` —
 * the same flag that decides `.env` versus `config.yaml` — and by nothing else.
 */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (v === '') return '(empty)';
  if (v.length <= 8) return `${'•'.repeat(v.length)} (${v.length} characters)`;
  return `${v.slice(0, 4)}${'•'.repeat(6)}${v.slice(-4)} (${v.length} characters)`;
}

/**
 * Ask for every declared field, in the order the plugin lists them.
 *
 * **Without `current`** — a NEW site — this returns null as soon as ANY prompt
 * is skipped: a half-entered site cannot authenticate, so recording it would
 * produce a config that loads "usable" and fails at publish time, the failure
 * mode the whole setup gate exists to avoid. Skipping means "not this site",
 * and the caller moves on.
 *
 * **With `current`** — UPDATING a site that is already configured — an empty
 * answer means "keep the value that is already there", which is a different
 * thing entirely. The two meanings are kept apart per FIELD, not per call: a
 * field with no usable current value (its `${VAR}` is unset, say) still takes
 * the new-site path, so skipping it still abandons the whole walk rather than
 * recording a site with a blank credential. Nothing an update does can weaken
 * the rule a new site is held to.
 */
export async function collectCredentialValues(
  fields: readonly CredentialField[],
  p: Prompter,
  current?: Record<string, string>,
): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {};

  for (const f of fields) {
    const kept = current?.[f.name]?.trim();
    if (kept) {
      // Never the raw value for a secret field: `secret: true` is what decides
      // this, here exactly as it does in `buildSiteBlock`.
      p.note(`${f.label} — currently ${f.secret ? maskSecret(kept) : kept}`);
      const answer = await p.text({
        message: `${f.label} (Enter to keep the current value)`,
        // A masked prompt shows no placeholder anyway, and a secret must not be
        // offered as one even if it did.
        placeholder: f.secret ? f.example : kept,
        secret: f.secret,
      });
      values[f.name] = answer === null || answer.trim() === '' ? kept : answer.trim();
      continue;
    }

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
 *
 * `current` turns this into the update walk: each field may be kept with an
 * empty answer (see `collectCredentialValues`). A KEPT credential is probed
 * exactly like a typed one — the merged values go to the same live check —
 * because `init`'s one promise is that nothing it writes has gone unverified,
 * and a key that worked last month is not a key that works now. On a retry the
 * seed becomes what was just attempted, so Enter keeps the correction rather
 * than silently reverting to the stored value; a NEW site keeps no seed at all
 * and so keeps abandoning on a skipped field, retry included.
 */
export async function collectSite(
  plugin: PlatformPlugin,
  slug: string,
  url: string,
  p: Prompter,
  probe: SiteProbe,
  current?: Record<string, string>,
): Promise<CollectedSite | null> {
  let seed = current;
  for (;;) {
    const values = await collectCredentialValues(plugin.credentialFields, p, seed);
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
        {
          value: 'skip',
          label: current ? 'Leave this blog as it was' : 'Skip this site',
          hint: current ? 'nothing is changed' : 'add it later with `byline init`',
        },
      ],
    });
    if (next !== 'retry') return null;
    // Updates only. `seed` stays undefined for a new site, so the skip-abandons
    // rule above survives every retry.
    if (current) seed = values;
  }
}

/** What the user decided about a key that is already in `.env`. */
type StoredKeyDecision = 'keep' | 'replace' | 'remove';

/**
 * Offer keep / replace / remove for a key that is already stored, and prove a
 * kept one still works.
 *
 * "Keep" is first so that pressing Enter — @clack's `select` confirms the
 * highlighted option, and the first option starts highlighted — changes
 * nothing. It is deliberately not a free pass: the stored value goes to the
 * same live probe a freshly typed one would, so a revoked or rotated-away key
 * is caught here rather than at the user's next `generate_image`. A failed
 * probe is not fatal either — the user may know the outage is temporary — but
 * it is stated, and replacing is the first offer.
 */
async function reviewStoredKey(
  provider: KeyedProvider,
  stored: string,
  p: Prompter,
  probe: ProviderProbe,
): Promise<StoredKeyDecision> {
  const chosen = await p.choose<StoredKeyDecision>({
    message: `${provider.name} already has a key (${maskSecret(stored)}). What now?`,
    options: [
      { value: 'keep', label: 'Keep it', hint: 'checked against the provider first' },
      { value: 'replace', label: 'Replace it', hint: 'enter a different key' },
      { value: 'remove', label: 'Remove it', hint: `deletes ${provider.credential.name}` },
    ],
  });
  if (chosen === 'replace' || chosen === 'remove') return chosen;

  const result = await probe(provider, stored);
  if (result.ok) return 'keep';

  p.problem(`${provider.name} no longer accepts the stored key:\n${result.detail}`);
  const next = await p.choose<StoredKeyDecision>({
    message: 'What now?',
    options: [
      { value: 'replace', label: 'Enter a different key' },
      { value: 'remove', label: `Remove ${provider.credential.name}`, hint: 'stop using this provider' },
      { value: 'keep', label: 'Leave it as it is', hint: 'nothing will work until it is fixed' },
    ],
  });
  return next ?? 'keep';
}

/**
 * What the provider walk decided for one env var: a value to write, or `null`
 * to delete the variable.
 *
 * `null` rather than a second return channel so the shape stays "the env vars
 * this run has an opinion about". A key the user KEPT appears in neither form —
 * it is already in `.env` under the same name, and rewriting it would be a
 * no-op that still reports a file as touched.
 */
export type ProviderKeyDecisions = Record<string, string | null>;

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
 *
 * `stored` is what `.env` already holds, keyed by the same env var names the
 * providers declare. A provider whose key is already there is never asked to be
 * retyped: it is shown as a masked fingerprint and offered keep / replace /
 * remove, with keep first so Enter changes nothing. **Keeping still probes**,
 * because the alternative is `init` reporting a revoked key as configured.
 */
export async function collectProviderKeys(
  families: readonly ProviderFamily[],
  p: Prompter,
  probe: ProviderProbe,
  ask: (question: string) => Promise<boolean>,
  stored: NodeJS.ProcessEnv = {},
): Promise<ProviderKeyDecisions> {
  const keys: ProviderKeyDecisions = {};

  for (const family of families) {
    const providers = family.providers(stored);
    const already = providers.filter((provider) => (stored[provider.credential.name] ?? '').trim() !== '');
    if (already.length > 0) {
      // Said before the family's own yes/no question so "No" is an informed
      // answer rather than an accidental one. The family is not named here —
      // its own `initPrompt` follows immediately.
      p.note(
        `Already set up: ${already
          .map((provider) => `${provider.name} (${provider.credential.name} = ${maskSecret(stored[provider.credential.name]!)})`)
          .join(', ')}. Answer No below to leave that exactly as it is.`,
      );
    }
    if (!(await ask(family.initPrompt))) continue;

    for (const provider of providers) {
      const existing = (stored[provider.credential.name] ?? '').trim();
      if (existing) {
        const decision = await reviewStoredKey(provider, existing, p, probe);
        if (decision === 'keep') continue;
        if (decision === 'remove') {
          keys[provider.credential.name] = null;
          continue;
        }
        // 'replace' falls through to the same entry walk a new key takes.
      }

      for (;;) {
        const c = provider.credential;
        p.note(c.secret && c.example ? `${c.label} — ${c.help} (looks like: ${c.example})` : `${c.label} — ${c.help}`);
        const answer = await p.text({
          // Backing out of a REPLACE leaves the stored key in place — nothing
          // is recorded for this variable, so `.env` is not touched. Saying
          // "skip" there would describe the wrong outcome.
          message: existing ? `${c.label} (Enter nothing to keep the current key)` : `${c.label} (Enter nothing to skip)`,
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
