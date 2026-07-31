import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { PLATFORM_IDS, getPlugin } from '../plugins/registry.js';
import { INIT_HINT } from '../setup.js';

/** Credentials, shaped by the platform. Ghost needs one key; WordPress needs two fields. */
export type SiteCredentials = Record<string, string>;

export interface SiteConfig {
  slug: string;
  platform: string;
  /** Public site URL, used for display and as the default API host. */
  url: string;
  /**
   * Admin API base endpoint. Defaults to whatever the platform's plugin derives
   * from `url` (`defaultApiUrl`), but many installs serve the admin API on a
   * different host or path than the public site — set `api_url` in sites.yaml
   * for those.
   */
  apiUrl: string;
  /**
   * Every resolved credential field, keyed by the platform's own field names
   * (`admin_api_key` for Ghost; `username`/`app_password` for WordPress) — the
   * single source of truth for credentials. A field is the empty string when
   * its environment variable is not set — see `unavailable`.
   */
  credentials: SiteCredentials;
  defaultAuthor?: string;
  /**
   * Why this site cannot be used, if it cannot. A site whose key is missing still
   * loads so that other sites keep working; `getSite` refuses it at point of use.
   */
  unavailable?: string;
}

export interface SitesConfig {
  defaultSite?: string;
  sites: Record<string, SiteConfig>;
}

const RawConfig = z.object({
  default_site: z.string().optional(),
  sites: z.record(z.string(), z.object({ platform: z.string() }).passthrough()),
});

/**
 * Matches a `${VAR}` reference in `config.yaml` and captures the variable
 * name. Exported so `src/cli/home-config.ts` can find the env var name a
 * config ALREADY references for a field, rather than re-deriving the pattern
 * by hand — a second hand-written copy is how `SLUG_PATTERN` and this kind of
 * thing drift.
 */
export const ENV_REF = /^\$\{([A-Z0-9_]+)\}$/;

/**
 * The one definition of a legal site slug, for both writers of `config.yaml`.
 *
 * `envVarNameFor` (`src/cli/home-config.ts`) uppercases a slug and collapses
 * every non-alphanumeric run to `_`, so `my-blog` and `my_blog` both produce
 * `MY_BLOG_*` — two sites silently sharing one credential env var, where
 * adding the second overwrites the first's key. Restricting the alphabet to
 * lowercase alphanumerics and hyphens makes that collision unreachable rather
 * than merely unlikely, and guarantees the derived name matches `ENV_REF`
 * above (a name outside `[A-Z0-9_]` fails to match on reload, and the `${…}`
 * text is then treated as a LITERAL credential).
 *
 * Both writers enforce THIS constant — `add_site`'s input schema and the CLI's
 * `promptSlug`. They already disagreed once, when only the CLI checked; a
 * second hand-written copy of the regex is how that happens again.
 *
 * Deliberately NOT enforced by `loadSites`: an existing config with an
 * unconventional slug keeps working. This constrains what gets written from
 * here on, and does not invalidate what someone already has on disk.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The human-facing statement of {@link SLUG_PATTERN}, shared by both writers. */
export const SLUG_RULE =
  'Use lowercase letters, digits, and hyphens only, starting with a letter or digit — e.g. "personal" or "company-blog".';

/**
 * Resolve a `${VAR}` reference, or return the literal if it isn't one.
 *
 * A missing variable is NOT fatal. One unconfigured site must not stop the others
 * from working — you add keys one at a time. The site is marked unavailable and
 * `getSite` refuses it with this reason when someone actually tries to use it.
 */
function resolveEnv(value: string, env: NodeJS.ProcessEnv): { key: string; missing?: string } {
  const m = ENV_REF.exec(value.trim());
  if (!m) return { key: value };
  const name = m[1]!;
  const found = env[name];
  if (!found) return { key: '', missing: name };
  return { key: found };
}

/** One missing `${VAR}` reference, paired with the example for the field it came from. */
interface MissingVar {
  varName: string;
  /** `CredentialField.example` for whichever field referenced `varName` — `<id:secret>` is
   *  Ghost's shape specifically; a WordPress user told to set an Application Password to
   *  that would be told to set it to the wrong thing entirely. Falls back to a generic
   *  placeholder only if the field somehow can't be found (should not happen in practice). */
  example: string;
}

/**
 * Compose one message naming every missing variable for a site, so a site missing
 * several credentials doesn't make the user fix them one restart at a time.
 */
function missingVarsMessage(slug: string, missing: MissingVar[]): string {
  if (missing.length === 1) {
    const { varName, example } = missing[0]!;
    return `Site "${slug}" needs environment variable ${varName}, which is not set. Add ${varName}=${example} to .env and restart.`;
  }
  return `Site "${slug}" needs environment variables ${missing.map((m) => m.varName).join(', ')}, which are not set. Add ${missing
    .map((m) => `${m.varName}=${m.example}`)
    .join(', ')} to .env and restart.`;
}

export function loadSites(
  file = 'config/sites.yaml',
  env: NodeJS.ProcessEnv = process.env,
): SitesConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ToolError({
      api: 'config',
      code: 'CONFIG_NOT_FOUND',
      message: `Cannot read site config at ${file}`,
      // Checkout-era advice ("copy config/sites.yaml from the repo") is aimed
      // at someone who by definition has no checkout — a fresh install never
      // did. `INIT_HINT` is the wording every other first-contact message uses.
      hint: INIT_HINT,
    });
  }

  const parsed = RawConfig.safeParse(parse(text));
  if (!parsed.success) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: `${file} is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    });
  }

  const entries = Object.entries(parsed.data.sites);
  if (entries.length === 0) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: `${file} defines no sites`,
      hint: 'Add at least one entry under `sites:`',
    });
  }

  const sites: Record<string, SiteConfig> = {};
  for (const [slug, rawUnknown] of entries) {
    const declared = (rawUnknown as { platform: string }).platform;

    let plugin;
    try {
      plugin = getPlugin(declared);
    } catch {
      // One unsupported platform must not stop the other sites from loading.
      // Verified 2026-07-29: rejecting the whole file for a hand-edited
      // `platform: wordpress` took three working Ghost sites down at once.
      sites[slug] = {
        slug,
        platform: declared,
        url: String((rawUnknown as { url?: string }).url ?? '').replace(/\/+$/, ''),
        apiUrl: '',
        credentials: {},
        unavailable: `Site "${slug}" uses unsupported platform "${declared}". Supported: ${PLATFORM_IDS.join(', ')}.`,
      };
      continue;
    }

    const parsedSite = plugin.credentialSchema.safeParse(rawUnknown);
    if (!parsedSite.success) {
      throw new ToolError({
        api: 'config',
        code: 'INVALID_CONFIG',
        message: `Site "${slug}" (${declared}) is invalid: ${parsedSite.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      });
    }

    const raw = parsedSite.data as Record<string, string | undefined>;
    const url = String(raw.url).replace(/\/+$/, '');

    // Resolve every ${ENV} reference the plugin's schema accepted. A site whose
    // variable is unset still loads — you add keys one at a time, and one missing
    // key must not stop the other sites from working.
    const exampleByField = new Map(plugin.credentialFields.map((f) => [f.name, f.example]));
    const credentials: SiteCredentials = {};
    const missing: MissingVar[] = [];
    for (const [field, value] of Object.entries(raw)) {
      if (typeof value !== 'string') continue;
      if (field === 'platform' || field === 'url' || field === 'api_url' || field === 'default_author') continue;
      const resolved = resolveEnv(value, env);
      credentials[field] = resolved.key;
      // The example is looked up per FIELD, not assumed — Ghost's admin_api_key
      // example (`id:secret`) is meaningless, or actively wrong, for WordPress's
      // app_password (`xxxx xxxx xxxx xxxx xxxx xxxx`).
      if (resolved.missing) {
        missing.push({ varName: resolved.missing, example: exampleByField.get(field) ?? '<value>' });
      }
    }
    const unavailable = missing.length > 0 ? missingVarsMessage(slug, missing) : undefined;

    sites[slug] = {
      slug,
      platform: declared,
      url,
      apiUrl: (raw.api_url ?? plugin.defaultApiUrl(url)).replace(/\/+$/, ''),
      credentials,
      ...(raw.default_author ? { defaultAuthor: raw.default_author } : {}),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  return {
    ...(parsed.data.default_site ? { defaultSite: parsed.data.default_site } : {}),
    sites,
  };
}

export function getSite(cfg: SitesConfig, slug: string): SiteConfig {
  const site = cfg.sites[slug];
  if (!site) {
    throw new ToolError({
      api: 'config',
      code: 'UNKNOWN_SITE',
      message: `No site "${slug}". Configured sites: ${Object.keys(cfg.sites).join(', ')}`,
    });
  }
  if (site.unavailable) {
    throw new ToolError({
      api: `config:${slug}`,
      code: 'MISSING_ENV',
      message: site.unavailable,
      hint: `Usable sites right now: ${usableSites(cfg).join(', ') || '(none)'}`,
    });
  }
  return site;
}

/** Slugs whose keys are present, so they can actually be published to. */
export function usableSites(cfg: SitesConfig): string[] {
  return Object.values(cfg.sites)
    .filter((s) => !s.unavailable)
    .map((s) => s.slug);
}
