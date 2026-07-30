import { existsSync } from 'node:fs';
import { cancel, confirm, intro, isCancel, outro } from '@clack/prompts';
import { type Paths, resolvePaths } from '../config/paths.js';
import { buildSiteBlock } from '../config/site-block.js';
import { SLUG_PATTERN, SLUG_RULE, loadSites, usableSites } from '../config/sites.js';
import { loadEnvFile } from '../config/dotenv.js';
import { PLATFORM_PLUGINS } from '../plugins/registry.js';
import type { PlatformPlugin } from '../plugins/platforms/types.js';
import { defaultChain } from '../plugins/images/index.js';
import {
  clackPrompter,
  collectImageProviderKeys,
  collectSite,
  liveProbe,
  liveProviderProbe,
  type CollectedSite,
  type Prompter,
} from './credentials.js';
import {
  ensureHome,
  envVarNameFor,
  seedPersonaTemplate,
  upsertEnvVars,
  writeSiteToConfig,
} from './home-config.js';
import { requireTty } from './interactive.js';
import { applyMigration, detectRepoConfig, planMigration } from './migrate.js';
import { promptAndWriteEditorConfigs } from './register.js';
import { NPM_PACKAGE } from './editor-config.js';
import { attention, detail, info, section } from './tree.js';

/**
 * `init` — the one command a non-technical person runs.
 *
 * Composition only: every step here is a function from another module, so the
 * wizard's job is the ORDER and the WORDS, both of which are the actual
 * deliverable. Nothing platform-specific appears — the platform list comes from
 * the registry and every prompt from a descriptor, so a third platform shows up
 * in this wizard the day it is registered, with no edit here.
 */

/**
 * Turn a collected site into files: the secret to `.env`, everything else to
 * `config.yaml` as a `${VAR}` reference.
 *
 * Split out from the wizard because this is the step where a wrong environment
 * variable name produces a site that loads as "usable" with an empty
 * credential and fails only at publish time — worth testing directly.
 */
export function persistSite(
  paths: Paths,
  plugin: PlatformPlugin,
  site: CollectedSite,
  makeDefault: boolean,
): { configFile: string; envFile: string; envVars: string[] } {
  ensureHome(paths);

  const envNames: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const field of plugin.credentialFields) {
    const value = site.values[field.name]!;
    if (field.secret) {
      const varName = envVarNameFor(site.slug, field.name);
      envNames[field.name] = varName;
      secrets[varName] = value;
    } else {
      envNames[field.name] = value;
    }
  }

  if (Object.keys(secrets).length > 0) upsertEnvVars(paths.envFile, secrets);
  writeSiteToConfig(paths.configFile, site.slug, buildSiteBlock(plugin, site.url, envNames, site.defaultAuthor), makeDefault);

  return { configFile: paths.configFile, envFile: paths.envFile, envVars: Object.keys(secrets) };
}

/** What the closing section of `init` found on disk, independent of what this session's loop did. */
export interface ConfiguredState {
  /** How many sites are DECLARED in config.yaml, usable or not — including ones migrated in, not added this run. */
  siteCount: number;
  /** Slugs whose credentials actually resolve — see `usableSites` in `../config/sites.js`. */
  usableSites: string[];
  /**
   * Every slug DECLARED in config.yaml, usable or not — including ones
   * migrated in or added in an earlier session, not just `added` (this
   * session's loop). `promptSlug` uses this to refuse a name that is already
   * taken on disk; before this it only ever checked `added`, so naming a new
   * blog after an already-configured one silently replaced it (Finding 1).
   */
  siteSlugs: string[];
}

/**
 * Read the truth from disk rather than trust a flag carried through the run.
 *
 * `added` (this session's loop) is not enough: a migration copies a fully
 * working `config.yaml` + `.env` without ever touching `added`, so a session
 * that only migrates and registers an editor must still be able to report
 * "ready" — and a session that copied a `config.yaml` whose credentials are
 * unset must NOT be reported as ready just because a file exists.
 *
 * `.env` is read through `loadEnvFile` into a COPY of `env`, never the real
 * `process.env` object, so this has no effect on the running process — the
 * wizard has nothing left to do with those variables once this is called.
 */
export function readConfiguredState(paths: Paths, env: NodeJS.ProcessEnv = process.env): ConfiguredState {
  const merged = { ...env };
  loadEnvFile(paths.envFile, merged);
  try {
    const sites = loadSites(paths.configFile, merged);
    return {
      siteCount: Object.keys(sites.sites).length,
      usableSites: usableSites(sites),
      siteSlugs: Object.keys(sites.sites),
    };
  } catch {
    // No config.yaml yet, or one that fails to parse — either way, nothing is
    // configured. `doctor` is where the parse failure itself gets surfaced.
    return { siteCount: 0, usableSites: [], siteSlugs: [] };
  }
}

export type Closing =
  | { kind: 'none' }
  | { kind: 'unusable' }
  | { kind: 'ready'; site: string };

/**
 * Decide what the closing section says, from the state actually on disk.
 *
 * Pure and separated from `runInit` specifically so this — the exact
 * contradiction Finding 1 named — is unit-testable without a terminal: a
 * migrated, already-credentialed `config.yaml` must produce `'ready'` even
 * when `added` (this session's loop) is empty.
 */
export function decideClosing(state: ConfiguredState, added: readonly string[]): Closing {
  if (state.usableSites.length > 0) {
    // Name a site this session touched when possible — the user just watched
    // it get validated — falling back to whatever else is usable.
    const site = added.find((s) => state.usableSites.includes(s)) ?? state.usableSites[0]!;
    return { kind: 'ready', site };
  }
  if (state.siteCount > 0) return { kind: 'unusable' };
  return { kind: 'none' };
}

async function ask(message: string, initialValue = true): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer)) {
    cancel('Cancelled.');
    process.exit(1);
  }
  return answer;
}

/**
 * Slug rules match what the rest of the system already accepts as a site key.
 *
 * `taken` must include every slug already on disk, not just this session's
 * `added` — see `ConfiguredState.siteSlugs`. Before this, `taken` was `added`
 * alone, so naming a new blog after one migrated in (or added in an earlier
 * session) passed validation here and then silently replaced it in
 * `writeSiteToConfig` (Finding 1).
 *
 * `p` defaults to the real `@clack/prompts`-backed `clackPrompter` but is
 * injectable so this — including the "already configured" rejection — is
 * unit-testable without a terminal.
 */
export async function promptSlug(taken: readonly string[], p: Prompter = clackPrompter): Promise<string | null> {
  for (;;) {
    const value = await p.text({
      message: 'Short name for this blog, used when you say "publish to …" (Enter nothing to skip)',
      placeholder: 'personal',
    });
    if (value === null) return null;
    const slug = value.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      p.problem(SLUG_RULE);
      continue;
    }
    if (taken.includes(slug)) {
      p.problem(`"${slug}" is already configured. Pick a different name.`);
      continue;
    }
    return slug;
  }
}

async function promptUrl(): Promise<string | null> {
  for (;;) {
    const value = await clackPrompter.text({
      message: 'Your blog address (Enter nothing to skip)',
      placeholder: 'https://blog.example.com',
    });
    if (value === null) return null;
    const url = value.startsWith('http') ? value : `https://${value}`;
    try {
      new URL(url);
      return url.replace(/\/+$/, '');
    } catch {
      clackPrompter.problem(`"${value}" is not a valid address. It should look like https://blog.example.com`);
    }
  }
}

export async function runInit(_args: string[]): Promise<void> {
  intro('byline — first-run setup');
  requireTty('`byline init`');

  const written: string[] = [];

  // --- 0. An existing repo checkout is a migration, not a fresh setup ---
  const repoConfig = detectRepoConfig();
  const paths = resolvePaths(process.env, undefined, '/nonexistent');

  if (repoConfig) {
    info(
      `Found an existing configuration in this folder (${repoConfig}).\n` +
        `Copying it to ${paths.home} makes it work no matter which folder your AI tool starts in.`,
    );
    if (await ask('Copy it to your home folder now?')) {
      ensureHome(paths);
      const items = applyMigration(planMigration(process.cwd(), paths));
      section('copied');
      const copied = items.filter((i) => i.action === 'copy');
      for (const item of copied) {
        if (item.error) {
          attention(`${item.to} — ${item.error}`);
        } else {
          detail(item.to);
          written.push(item.to);
        }
      }
      for (const item of items.filter((i) => i.action === 'skip-exists')) {
        detail(`${item.to} (left as it was — already present)`);
      }
      const failed = copied.filter((i) => i.error);
      if (failed.length > 0) {
        attention(
          `${failed.length} of ${copied.length} file(s) failed to copy — see above. ` +
            'Re-run `byline migrate --yes` once the cause is fixed.',
        );
      }
    }
  }

  // --- 1. Register with the AI tools actually on this machine ---
  const registered = await promptAndWriteEditorConfigs();

  // --- 2. Blogs ---
  // No `ensureHome(paths)` here: `persistSite` (below), `upsertEnvVars`, and
  // `seedPersonaTemplate` already create only the directories they actually
  // need. Creating ~/.byline/ unconditionally — regardless of what the
  // user answers next — permanently shadows a working repo-local checkout the
  // moment the directory exists, because `resolvePaths` picks ~/.byline/
  // over the repo whenever it exists at all, even empty (Finding 2).
  const plugins = Object.values(PLATFORM_PLUGINS);
  const added: string[] = [];
  // Read once, before the loop: every slug already on disk (migrated in, or
  // from an earlier session), independent of what THIS session adds. See
  // `promptSlug` and Finding 1.
  const existingSlugs = readConfiguredState(paths).siteSlugs;

  for (;;) {
    const first = added.length === 0;
    if (!first && !(await ask('Add another blog?', false))) break;
    if (first && !(await ask('Set up a blog to publish to now?'))) break;

    const platformId = await clackPrompter.choose({
      message: 'Which kind of blog?',
      options: plugins.map((p) => ({ value: p.id, label: p.label })),
    });
    if (platformId === null) break;
    const plugin = PLATFORM_PLUGINS[platformId]!;

    const slug = await promptSlug([...existingSlugs, ...added]);
    if (slug === null) break;

    const url = await promptUrl();
    if (url === null) break;

    // Live-validated at entry: a credential that has not been proven to work is
    // never written. See src/cli/credentials.ts for why that is absolute here.
    const site = await collectSite(plugin, slug, url, clackPrompter, liveProbe);
    if (!site) {
      info(`Skipped "${slug}". You can add it later by running \`byline init\` again.`);
      continue;
    }

    // Always `false`: `writeSiteToConfig` already makes a site the default
    // when none exists yet (`!doc.default_site`). Passing `added.length === 0`
    // here used to force `makeDefault: true` for the first blog THIS SESSION
    // adds, which stole `default_site` from an already-configured (e.g.
    // migrated) site even though the new slug was never in conflict — a
    // newly added blog must only become the default when there is no default
    // already (Finding 1).
    const result = persistSite(paths, plugin, site, false);
    added.push(slug);
    section(`blog "${slug}"`);
    detail(`config    ${result.configFile}`);
    written.push(result.configFile);
    if (result.envVars.length > 0) {
      detail(`secret    ${result.envFile}   (${result.envVars.join(', ')})`);
      written.push(result.envFile);
    }
  }

  // --- 3. Image generation ---
  let imageKeys: Record<string, string> = {};
  if (await ask('Set up AI image generation for hero images? (optional)', false)) {
    imageKeys = await collectImageProviderKeys(defaultChain({}), clackPrompter, liveProviderProbe);
    if (Object.keys(imageKeys).length > 0) {
      upsertEnvVars(paths.envFile, imageKeys);
      section('image generation');
      detail(`${paths.envFile}   (${Object.keys(imageKeys).join(', ')})`);
      written.push(paths.envFile);
    }
  }

  // --- 4. Author persona template ---
  // Only once ~/.byline/ has (or already had) a real reason to exist —
  // otherwise this alone would create it (and so permanently shadow a
  // repo-local checkout, see Finding 2) for a session where the user declined
  // every other step. `written.length > 0` covers anything written above;
  // `existsSync(paths.home)` covers a user who already had the directory
  // before this run.
  if (written.length > 0 || existsSync(paths.home)) {
    const template = seedPersonaTemplate(paths.personasDir);
    if (template) {
      section('author profile');
      detail(`${template}   — copy it to <your-name>.yaml and fill it in to shape how drafts sound`);
      written.push(template);
    }
  }

  // --- 5. Exactly where everything went ---
  section('everything written');
  if (written.length === 0) {
    detail('nothing — every step was skipped');
  } else {
    for (const file of [...new Set(written)]) detail(file);
  }

  // --- 6. The first sentence to type, copy-pasteable ---
  // Read the truth from disk rather than `added` (this session's loop):
  // a migration can land a fully working config.yaml + .env without ever
  // touching `added`, and reporting "no blog configured" over that
  // contradicts the file list printed seconds ago. See `decideClosing`.
  const closing = decideClosing(readConfiguredState(paths), added);

  if (closing.kind === 'none') {
    outro(
      'No blog configured yet. Run `byline init` again when you have your blog address and API key, ' +
        'or `byline doctor` to see what is missing.',
    );
    return;
  }

  if (closing.kind === 'unusable') {
    outro(
      'Blog(s) are configured, but none have working credentials yet — run `byline doctor` to see what is missing.',
    );
    return;
  }

  section('what to say in your AI tool');
  detail(`Write a blog post about <your topic> and publish it to ${closing.site} as a draft.`);

  outro(
    registered.length > 0
      ? `Done. Restart ${registered.length === 1 ? 'your AI tool' : 'your AI tools'} so they load byline, then paste the line above.`
      : `Done. Register with an AI tool when ready: claude mcp add byline -- npx -y ${NPM_PACKAGE}`,
  );
}
