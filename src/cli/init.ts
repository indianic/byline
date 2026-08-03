import { existsSync } from 'node:fs';
import { cancel, confirm, intro, isCancel, outro } from '@clack/prompts';
import { type Paths, resolvePaths } from '../config/paths.js';
import { buildSiteBlock } from '../config/site-block.js';
import { SLUG_PATTERN, SLUG_RULE, type SitesConfig, loadSites, usableSites } from '../config/sites.js';
import { loadEnvFile } from '../config/dotenv.js';
import { PLATFORM_PLUGINS } from '../plugins/registry.js';
import type { PlatformPlugin } from '../plugins/platforms/types.js';
import { providerFamilies } from '../plugins/providers.js';
import {
  clackPrompter,
  collectProviderKeys,
  collectSite,
  liveProbe,
  liveProviderProbe,
  type CollectedSite,
  type Prompter,
} from './credentials.js';
import {
  ensureHome,
  envVarNameFor,
  existingSecretEnvVars,
  removeEnvVars,
  seedPersonaTemplate,
  upsertEnvVars,
  writeSiteToConfig,
} from './home-config.js';
import {
  buildPersonaRecord,
  promptPersonaAnswers,
  readExistingPersonas,
  updatePersonaRecord,
  writePersonaFile,
} from './persona-setup.js';
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
 *
 * The env var name for each secret field is not always freshly computed: if
 * `config.yaml` already references one for this slug and field (checked via
 * `existingSecretEnvVars`), that name is reused instead. On a new site there
 * is nothing to find, so this is a no-op and `envVarNameFor` runs exactly as
 * before. On an update, this is what stops a hand-set reference (e.g.
 * `${MY_CUSTOM_GHOST_KEY}`) from being silently renamed to the computed name
 * — which would also leave the OLD secret behind in `.env`, live and
 * orphaned, under a name `config.yaml` no longer points at. Replacing the
 * VALUE under the reused name is fine and intended: `upsertEnvVars` just
 * overwrites that key in place, so there is still exactly one copy.
 */
export function persistSite(
  paths: Paths,
  plugin: PlatformPlugin,
  site: CollectedSite,
  makeDefault: boolean,
  options: { replace?: boolean } = {},
): { configFile: string; envFile: string; envVars: string[] } {
  ensureHome(paths);

  const existingNames = existingSecretEnvVars(paths.configFile, site.slug, plugin);
  const envNames: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const field of plugin.credentialFields) {
    const value = site.values[field.name]!;
    if (field.secret) {
      const varName = existingNames[field.name] ?? envVarNameFor(site.slug, field.name);
      envNames[field.name] = varName;
      secrets[varName] = value;
    } else {
      envNames[field.name] = value;
    }
  }

  if (Object.keys(secrets).length > 0) upsertEnvVars(paths.envFile, secrets);
  writeSiteToConfig(
    paths.configFile,
    site.slug,
    buildSiteBlock(plugin, site.url, envNames, site.defaultAuthor),
    makeDefault,
    options,
  );

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
 * Everything already configured, credentials RESOLVED, or null when nothing is.
 *
 * The resolution is the point: `SiteConfig.credentials` here holds the real
 * values `.env` supplies, not the `${VAR}` text `config.yaml` stores, which is
 * what lets the update walk offer to keep a credential — and then prove the
 * kept one still works — without ever asking the user to retype it.
 *
 * `.env` is read through `loadEnvFile` into a COPY of `env`, never the real
 * `process.env` object, so this has no effect on the running process. Reading
 * creates nothing on disk: `init` must not bring the config home into being
 * merely by looking at it (Finding 2).
 */
export function readConfiguredSites(paths: Paths, env: NodeJS.ProcessEnv = process.env): SitesConfig | null {
  const merged = { ...env };
  loadEnvFile(paths.envFile, merged);
  try {
    return loadSites(paths.configFile, merged);
  } catch {
    // No config.yaml yet, or one that fails to parse — either way, nothing is
    // configured. `doctor` is where the parse failure itself gets surfaced.
    return null;
  }
}

/**
 * Read the truth from disk rather than trust a flag carried through the run.
 *
 * `added` (this session's loop) is not enough: a migration copies a fully
 * working `config.yaml` + `.env` without ever touching `added`, so a session
 * that only migrates and registers an editor must still be able to report
 * "ready" — and a session that copied a `config.yaml` whose credentials are
 * unset must NOT be reported as ready just because a file exists.
 */
export function readConfiguredState(paths: Paths, env: NodeJS.ProcessEnv = process.env): ConfiguredState {
  const sites = readConfiguredSites(paths, env);
  if (!sites) return { siteCount: 0, usableSites: [], siteSlugs: [] };
  return {
    siteCount: Object.keys(sites.sites).length,
    usableSites: usableSites(sites),
    siteSlugs: Object.keys(sites.sites),
  };
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

/**
 * Ask for the blog address.
 *
 * With `current` — updating a blog that is already configured — an empty answer
 * keeps that address and this never returns null. Without one, an empty answer
 * still means "skip", and the caller still abandons the site, exactly as
 * before: the two meanings live in different calls and cannot leak into each
 * other. Injectable `Prompter` so both are testable without a terminal.
 */
export async function promptUrl(p: Prompter = clackPrompter, current?: string): Promise<string | null> {
  for (;;) {
    const value = await p.text({
      message: current ? `Blog address (Enter to keep ${current})` : 'Your blog address (Enter nothing to skip)',
      placeholder: current ?? 'https://blog.example.com',
    });
    if (value === null) return current ?? null;
    const url = value.startsWith('http') ? value : `https://${value}`;
    try {
      new URL(url);
      return url.replace(/\/+$/, '');
    } catch {
      p.problem(`"${value}" is not a valid address. It should look like https://blog.example.com`);
    }
  }
}

/**
 * The "add a new one" entry in a menu whose other entries are slugs.
 *
 * `SLUG_PATTERN` requires a leading lowercase letter or digit, so no legal slug
 * can ever be this string — the sentinel cannot be shadowed by a real blog.
 */
const NEW_BLOG = '+new';

/** Same idea for the persona menu: `slugifyPersonaName` can never produce these. */
const KEEP_PERSONAS = '+keep';
const NEW_PERSONA = '+new';

/**
 * Walk one already-configured blog, keeping whatever the user does not change.
 *
 * Everything here is driven off the plugin the CONFIG names — the platform is
 * never re-asked, because changing a blog's platform is not an edit, it is a
 * different blog. Returns null when nothing was written, having already said
 * why.
 *
 * The stored credentials go in as `current`, so each field offers to be kept —
 * and the merged result is then put through the same live probe a brand-new
 * site faces. A kept key is therefore proven, not assumed: this is the one
 * promise `init` makes about everything it writes, and "the user didn't retype
 * it" is not a reason to stop keeping it.
 */
async function updateBlog(
  paths: Paths,
  configured: SitesConfig,
  slug: string,
): Promise<{ configFile: string; envFile: string; envVars: string[] } | null> {
  const current = configured.sites[slug]!;
  const plugin = PLATFORM_PLUGINS[current.platform];
  if (!plugin) {
    attention(
      `"${slug}" is configured for platform "${current.platform}", which this version of byline does not support — ` +
        'left exactly as it is.',
    );
    return null;
  }

  info(
    `Updating "${slug}" — ${plugin.label} at ${current.url}.\n` +
      'Press Enter at any question to keep what is already there.',
  );

  const url = await promptUrl(clackPrompter, current.url);
  if (url === null) return null;

  const site = await collectSite(plugin, slug, url, clackPrompter, liveProbe, current.credentials);
  if (!site) {
    info(`Left "${slug}" exactly as it was.`);
    return null;
  }

  // `replace: true` is reached only from the menu above — an explicit pick of
  // an existing blog — never from a name collision. `writeSiteToConfig` merges
  // over the existing block, so a hand-set `api_url` survives.
  return persistSite(
    paths,
    plugin,
    { ...site, ...(current.defaultAuthor ? { defaultAuthor: current.defaultAuthor } : {}) },
    false,
    { replace: true },
  );
}

/**
 * The five questions for a persona that does not exist yet, plus the file.
 *
 * Kept out of `runInit` so the create path reads identically whether it was
 * reached on a first run or picked as "add another" on a re-run — one
 * definition, not two that can drift in wording.
 */
async function writeNewPersona(paths: Paths, written: string[]): Promise<void> {
  const answers = await promptPersonaAnswers(clackPrompter);
  if (!answers) {
    info('Skipped — set this up any time. See the template path below.');
    return;
  }

  const record = buildPersonaRecord(answers);
  const result = writePersonaFile(paths.personasDir, record);
  if (result.alreadyExisted) {
    info(
      `A persona named "${record.slug as string}" already exists at ${result.path} — left untouched. ` +
        'Run `byline init` again and pick "Update" to change it.',
    );
    return;
  }

  section('author persona');
  detail(result.path);
  written.push(result.path);
  info(
    `Say "as ${answers.name}" and drafts use this voice. Edit ${result.path} any time — ` +
      'the more you fill in, the more distinctive the writing gets.',
  );
}

export async function runInit(_args: string[]): Promise<void> {
  requireTty('`byline init`');

  const written: string[] = [];

  // --- 0. An existing repo checkout is a migration, not a fresh setup ---
  const repoConfig = detectRepoConfig();
  const paths = resolvePaths(process.env, undefined, '/nonexistent');

  // Named for what this run actually is. Calling a re-run "first-run setup"
  // while it lists four already-configured blogs is the first sentence the
  // user reads, and it is false.
  intro(existsSync(paths.configFile) ? 'byline — setup (existing configuration found)' : 'byline — first-run setup');

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
  const changed: string[] = [];

  for (;;) {
    // Re-read every pass, so a blog added a moment ago is immediately
    // updatable and immediately refused as a new name. Reading creates
    // nothing (see `readConfiguredSites`), so this is safe before the user
    // has answered anything.
    const configured = readConfiguredSites(paths);
    const existingSlugs = configured ? Object.keys(configured.sites) : [];
    const first = added.length === 0 && changed.length === 0;

    if (first) {
      // Default No when something is already set up: a re-run must be
      // Enter-through-able without changing a thing.
      const question = existingSlugs.length > 0 ? 'Add or change a blog now?' : 'Set up a blog to publish to now?';
      if (!(await ask(question, existingSlugs.length === 0))) break;
    } else if (!(await ask('Add or change another blog?', false))) break;

    // Which blog — asked only when there is something to choose between.
    // Updating an existing blog is a deliberate pick off this menu and can
    // never be reached by typing a name that happens to collide; `promptSlug`
    // still refuses a taken name on the new-blog path below (Finding 1).
    let updating: string | null = null;
    if (existingSlugs.length > 0) {
      const which = await clackPrompter.choose({
        message: 'Which blog?',
        options: [
          { value: NEW_BLOG, label: 'Add a new blog' },
          ...existingSlugs.map((slug) => {
            const site = configured!.sites[slug]!;
            return { value: slug, label: `Update "${slug}"`, hint: `${site.platform} — ${site.url}` };
          }),
        ],
      });
      if (which === null) break;
      if (which !== NEW_BLOG) updating = which;
    }

    if (updating !== null) {
      const result = await updateBlog(paths, configured!, updating);
      if (result) {
        changed.push(updating);
        section(`blog "${updating}" updated`);
        detail(`config    ${result.configFile}`);
        written.push(result.configFile);
        if (result.envVars.length > 0) {
          detail(`secret    ${result.envFile}   (${result.envVars.join(', ')})`);
          written.push(result.envFile);
        }
      }
      continue;
    }

    const platformId = await clackPrompter.choose({
      message: 'Which kind of blog?',
      options: plugins.map((p) => ({ value: p.id, label: p.label })),
    });
    if (platformId === null) break;
    const plugin = PLATFORM_PLUGINS[platformId]!;

    const slug = await promptSlug(existingSlugs);
    if (slug === null) break;

    const url = await promptUrl();
    if (url === null) break;

    // Live-validated at entry: a credential that has not been proven to work is
    // never written. See src/cli/credentials.ts for why that is absolute here.
    // No `current` is passed, so a skipped field still abandons the whole site.
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

  // --- 3. Provider keys (image generation, research, and any future family) ---
  //
  // No family is named here. Each one supplies its own yes/no question, so a
  // new family appears in the installer with no edit to this file.
  //
  // `(q) => ask(q, false)`, not `ask` directly: `ask`'s own default
  // (`initialValue = true`) would flip every family's prompt to default-Yes.
  // Image setup is opt-in — the prompt must keep defaulting to No.
  //
  // `stored` is the CONTENTS OF `.env` and nothing else — deliberately not
  // `process.env`. A key exported in the user's shell is a key this file
  // cannot keep, replace, or remove, so offering to do so would be a lie; such
  // a provider is simply asked for as if new, exactly as it always was.
  const stored: NodeJS.ProcessEnv = {};
  loadEnvFile(paths.envFile, stored);

  const decisions = await collectProviderKeys(
    providerFamilies(),
    clackPrompter,
    liveProviderProbe,
    (q) => ask(q, false),
    stored,
  );
  const toWrite: Record<string, string> = {};
  const toRemove: string[] = [];
  for (const [name, value] of Object.entries(decisions)) {
    if (value === null) toRemove.push(name);
    else toWrite[name] = value;
  }
  if (Object.keys(toWrite).length > 0) upsertEnvVars(paths.envFile, toWrite);
  const removed = removeEnvVars(paths.envFile, toRemove);
  if (Object.keys(toWrite).length > 0 || removed.length > 0) {
    section('provider keys');
    if (Object.keys(toWrite).length > 0) detail(`${paths.envFile}   (${Object.keys(toWrite).join(', ')})`);
    if (removed.length > 0) detail(`${paths.envFile}   removed ${removed.join(', ')}`);
    written.push(paths.envFile);
  }

  // --- 4. Author persona ---
  // Asked BEFORE the "was anything else written?" gate below, and on purpose:
  // answering these questions and getting a real persona file out is itself
  // a real reason for ~/.byline/ to exist, same as adding a blog or an image
  // key is — Finding 2's guard is "don't create the directory for NOTHING
  // written," and a persona is not nothing. `writePersonaFile` only touches
  // disk once a complete, schema-valid answer set exists (see
  // `promptPersonaAnswers`), so a decline or an early skip still creates
  // nothing, exactly like every other step here.
  //
  // Checked BEFORE a single question is asked. This used to run the whole
  // five-question walk and only then discover the file was already there, at
  // which point `writePersonaFile` reported `alreadyExisted` and discarded
  // every answer the user had just typed — the worst of the three re-run
  // failures, because the work was done and then thrown away.
  const personas = readExistingPersonas(paths.personasDir);

  if (personas.length > 0) {
    const choice = await clackPrompter.choose({
      message: `You already have ${personas.length === 1 ? 'an author persona' : `${personas.length} author personas`}. What now?`,
      options: [
        { value: KEEP_PERSONAS, label: 'Keep as they are', hint: 'nothing is asked, nothing is changed' },
        ...personas.map((persona) => ({
          value: persona.slug,
          label: `Update "${persona.answers.name}"`,
          hint: persona.answers.role || persona.path,
        })),
        { value: NEW_PERSONA, label: 'Add another author persona' },
      ],
    });

    if (choice !== null && choice !== KEEP_PERSONAS) {
      const target = personas.find((persona) => persona.slug === choice);
      if (target) {
        info(`Updating "${target.answers.name}" (${target.path}). Press Enter at any question to keep the current answer.`);
        const answers = await promptPersonaAnswers(clackPrompter, target.answers);
        if (answers) {
          // Merged into the file's OWN contents and rewritten under the same
          // slug, so hand-edited fields the five questions never ask about
          // survive, and the filename still matches the slug even when the
          // name changed. See `updatePersonaRecord`.
          const result = writePersonaFile(paths.personasDir, updatePersonaRecord(target.record, answers, target.slug), {
            replace: true,
          });
          section('author persona updated');
          detail(result.path);
          written.push(result.path);
        } else {
          info(`Left "${target.answers.name}" exactly as it was.`);
        }
      } else {
        await writeNewPersona(paths, written);
      }
    }
  } else if (
    await ask(
      'Set up your author voice now? A persona makes drafts sound like you instead of generic AI output. (optional)',
    )
  ) {
    await writeNewPersona(paths, written);
  }

  // Only once ~/.byline/ has (or already had) a real reason to exist —
  // otherwise this alone would create it (and so permanently shadow a
  // repo-local checkout, see Finding 2) for a session where the user declined
  // every other step. `written.length > 0` covers anything written above,
  // including a persona from the step just above; `existsSync(paths.home)`
  // covers a user who already had the directory before this run.
  if (written.length > 0 || existsSync(paths.home)) {
    const template = seedPersonaTemplate(paths.personasDir);
    if (template) {
      section('persona template');
      detail(`${template}   — copy it to <your-name>.yaml for a second persona, or start here if you skipped above`);
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
