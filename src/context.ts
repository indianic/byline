import { loadPersonas, type Persona } from './config/personas.js';
import { loadSites, usableSites, type SitesConfig } from './config/sites.js';
import { checkEnvPermissions, loadEnvFile } from './config/dotenv.js';
import { resolvePaths, type Paths } from './config/paths.js';
import { ToolError } from './errors.js';
import { defaultChain } from './plugins/images/index.js';
import { researchProviders } from './plugins/research/index.js';
import type { SetupState } from './setup.js';

export interface Context {
  paths: Paths;
  /** Kept for the tools that rewrite the config file in place. */
  sitesFile: string;
  personasDir: string;
  sites: SitesConfig;
  personas: Map<string, Persona>;
  runsDir: string;
  setup: SetupState;
  /**
   * The environment `loadContext` resolved everything against. Tools that
   * mutate `ctx.sites` in place (`add_site`, `remove_site`) must re-resolve
   * against THIS, not the ambient `process.env` — under a custom env (as in
   * tests, or an embedder that doesn't run under a plain process env) the two
   * can differ, and reloading against the wrong one silently flips an
   * unrelated site's usability.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Providers whose key is present, derived from the providers themselves rather
 * than reimplemented here. This used to hardcode `GEMINI_API_KEY` / `XAI_API_KEY`
 * directly, which meant every new image provider needed a matching edit in this
 * file as well as its own plugin — the two were free to drift, and did nothing
 * to stop a third provider from being added to `defaultChain` without ever being
 * added here. Asking `defaultChain(env)` for its providers and each provider its
 * own `configured()` keeps this file ignorant of what any given provider's key
 * is even called.
 */
function configuredImageProviders(env: NodeJS.ProcessEnv): string[] {
  return defaultChain(env)
    .filter((p) => p.configured())
    .map((p) => p.name);
}

/**
 * Mirrors `configuredImageProviders`: asks each provider whether it is
 * configured rather than listing env var names here a second time, so a new
 * provider cannot be added to the family without appearing in `status`.
 */
function configuredResearchProviders(env: NodeJS.ProcessEnv): string[] {
  return researchProviders(env)
    .filter((p) => p.configured())
    .map((p) => p.name);
}

/**
 * Build `setup` from the current sites/personas state.
 *
 * This is the ONLY place that computes `SetupState`. `loadContext` calls it on
 * startup; any tool that mutates `ctx.sites` in place (`add_site`,
 * `remove_site`) must call it again afterward so `ctx.setup` never describes a
 * config that no longer exists. Two code paths building this by hand is exactly
 * how they drift — see the `add_site` bug this replaced.
 *
 * `extraProblems` carries messages that cannot be recovered from `sites` /
 * `personas` themselves, such as a config file that failed to parse at all
 * (the objects passed in are already the post-failure fallbacks in that case).
 */
export function buildSetupState(
  paths: Paths,
  sites: SitesConfig,
  personas: Map<string, Persona>,
  extraProblems: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): SetupState {
  const problems: string[] = [...extraProblems];
  const siteProblems: string[] = [];

  const permissionWarning = checkEnvPermissions(paths.envFile);
  if (permissionWarning) problems.push(permissionWarning);

  for (const site of Object.values(sites.sites)) {
    if (site.unavailable) {
      problems.push(site.unavailable);
      siteProblems.push(site.unavailable);
    }
  }

  const usable = usableSites(sites);

  return {
    configured: usable.length > 0,
    paths,
    siteCount: Object.keys(sites.sites).length,
    usableSiteCount: usable.length,
    personaCount: personas.size,
    imageProviders: configuredImageProviders(env),
    researchProviders: configuredResearchProviders(env),
    problems,
    siteProblems,
  };
}

/**
 * Build the runtime context. Never throws.
 *
 * A brand-new user has no config at all, and an MCP host launches this server
 * before they have run `init`. Throwing here would make every tool — including
 * the diagnostic ones — fail with a stack trace instead of a message naming the
 * fix. Problems are collected into `setup` and reported by health_check, doctor,
 * and the gate in requireSetup.
 */
/**
 * A thrown value's user-facing text, hint included.
 *
 * `ToolError.hint` never survives `.toJSON()` into a plain string, and
 * `status`/`doctor` only ever print `problems` as bare strings — so a
 * `CONFIG_NOT_FOUND` whose entire fix lives in `hint` (e.g. "run `byline
 * init`") reached a fresh user as a bare "Cannot read site config at …" with
 * no fix attached. Folding the hint into the message here is what a
 * first-contact user actually sees.
 */
function problemMessage(e: unknown): string {
  if (e instanceof ToolError) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

export function loadContext(env: NodeJS.ProcessEnv = process.env): Context {
  const paths = resolvePaths(env);
  loadEnvFile(paths.envFile, env);

  const extraProblems: string[] = [];

  let sites: SitesConfig = { sites: {} };
  try {
    sites = loadSites(paths.configFile, env);
  } catch (e) {
    extraProblems.push(problemMessage(e));
  }

  let personas = new Map<string, Persona>();
  try {
    personas = loadPersonas(paths.personasDir);
  } catch (e) {
    extraProblems.push(problemMessage(e));
  }

  return {
    paths,
    sitesFile: paths.configFile,
    personasDir: paths.personasDir,
    sites,
    personas,
    runsDir: paths.runsDir,
    setup: buildSetupState(paths, sites, personas, extraProblems, env),
    env,
  };
}
