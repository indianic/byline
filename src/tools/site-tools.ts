// src/tools/site-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { buildSiteBlock } from '../config/site-block.js';
import { SLUG_PATTERN, SLUG_RULE, loadSites, usableSites } from '../config/sites.js';
import { buildSetupState, type Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { imageHealth } from '../plugins/images/index.js';
import { PLATFORM_IDS, getPlugin, makeAdapter } from '../plugins/registry.js';
import { researchHealth } from '../plugins/research/index.js';
import { adapterFor, handler } from './shared.js';

type RawSitesConfig = { default_site?: string; sites: Record<string, unknown> };

/**
 * Read and parse `sites.yaml`, tolerating the states a brand-new or hand-edited
 * file can genuinely be in: missing entirely (returns `null` — callers decide
 * whether that's fine), or present but empty (`parse('')` is `null`, and a file
 * with no `sites:` key at all, and `sites:` present but `null`). Neither is
 * `add_site` or `remove_site`'s job to treat as a crash.
 *
 * States that are NOT tolerated, because silently working around them
 * corrupts the file instead of helping: YAML that fails to parse at all, YAML
 * that parses to something other than a mapping at the top level (e.g. a bare
 * scalar like `hello`, or a list), and a `sites:` key that itself holds
 * something other than a mapping (e.g. `sites: hello`, or a list under
 * `sites:`). All are reported as a `ToolError` naming the file.
 */
function readRawSitesConfig(file: string): RawSitesConfig | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = parse(text) ?? {};
  } catch (e) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: `${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Fix the syntax by hand, or restore from config/sites.example.yaml.',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: `${file} must be a YAML mapping with a top-level \`sites:\` key, not ${
        Array.isArray(parsed) ? 'a list' : typeof parsed
      }.`,
      hint: 'See config/sites.example.yaml for the expected shape.',
    });
  }

  const obj = parsed as { default_site?: string; sites?: unknown };
  if (obj.sites !== undefined && obj.sites !== null) {
    if (typeof obj.sites !== 'object' || Array.isArray(obj.sites)) {
      throw new ToolError({
        api: 'config',
        code: 'INVALID_CONFIG',
        message: `${file}: \`sites:\` must be a mapping of site name to config, not ${
          Array.isArray(obj.sites) ? 'a list' : typeof obj.sites
        }.`,
        hint: 'See config/sites.example.yaml for the expected shape.',
      });
    }
  }

  return { ...obj, sites: (obj.sites as Record<string, unknown> | undefined) ?? {} };
}

export function registerSiteTools(server: McpServer, ctx: Context): void {
  // ---- health_check ----
  // NEVER gated. This is the diagnostic path: it has to work in exactly the
  // broken state that makes someone reach for it.
  server.registerTool(
    'health_check',
    {
      title: 'Health check',
      description:
        'Probe every configured blog plus every image and research provider. Returns per-API ok/fail with the real error. Run this first when anything fails.',
      inputSchema: {},
    },
    handler('health_check', async () => {
      const sites = await Promise.all(
        Object.values(ctx.sites.sites).map(async (s) =>
          // A site with no key can't be probed — report why instead of a doomed request.
          s.unavailable
            ? { slug: s.slug, platform: s.platform, ok: false, detail: s.unavailable }
            : makeAdapter(s).healthCheck(),
        ),
      );
      return ok({
        configured: ctx.setup.configured,
        config_file: ctx.paths.configFile,
        sites,
        images: await imageHealth(),
        research: await researchHealth(),
        ...(ctx.setup.problems.length > 0 ? { problems: ctx.setup.problems } : {}),
      });
    }),
  );

  // ---- list_sites ----
  server.registerTool(
    'list_sites',
    {
      title: 'List sites',
      description: 'List configured publishing targets. Never returns key material.',
      inputSchema: {},
    },
    handler('list_sites', async () =>
      ok({
        defaultSite: ctx.sites.defaultSite,
        usable: usableSites(ctx.sites),
        sites: Object.values(ctx.sites.sites).map((s) => ({
          slug: s.slug,
          platform: s.platform,
          url: s.url,
          defaultAuthor: s.defaultAuthor,
          usable: !s.unavailable,
          ...(s.unavailable ? { unavailable: s.unavailable } : {}),
        })),
      }),
    ),
  );

  // ---- add_site ----
  server.registerTool(
    'add_site',
    {
      title: 'Add site',
      description:
        'Add a publishing target to config/sites.yaml. Secret credential fields are recorded as a reference to a .env variable name; the value itself goes in .env, never in config.yaml.',
      inputSchema: {
        slug: z
          .string()
          .describe(
            'Short name used when publishing, e.g. "indianic". Lowercase letters, digits, and hyphens only.',
          ),
        platform: z.string().describe(`One of: ${PLATFORM_IDS.join(', ')}`),
        url: z.string().url(),
        credentials: z
          .record(z.string(), z.string())
          .describe(
            "Keyed by this platform's credential field names. For a secret field pass the NAME of the .env variable holding the value; for a non-secret field pass the value itself. Call list_sites or read the error from a wrong platform to see the field names.",
          ),
        default_author: z.string().optional(),
      },
    },
    handler(
      'add_site',
      async (a: {
        slug: string;
        platform: string;
        url: string;
        credentials: Record<string, string>;
        default_author?: string;
      }) => {
        // Constrain the slug to the alphabet `envVarNameFor` can represent
        // one-to-one. That function collapses every non-alphanumeric run to
        // `_`, so `my-blog` and `my_blog` both derive MY_BLOG_ADMIN_API_KEY —
        // adding the second site would silently overwrite the first site's
        // credential in .env. The CLI's promptSlug has always refused the
        // second shape; this was the remaining way in.
        //
        // Checked here rather than as a `.regex()` on the input schema on
        // purpose: a schema rejection surfaces as a raw MCP protocol error,
        // while every other refusal in this tool returns the error envelope an
        // AI-tool caller can actually act on — naming the rule, not just the
        // fact of failure.
        if (!SLUG_PATTERN.test(a.slug)) {
          throw new ToolError({
            api: 'config',
            code: 'INVALID_SLUG',
            message: `"${a.slug}" is not a usable site name. ${SLUG_RULE}`,
            hint: 'The name is used both as the key in config.yaml and to derive this site\'s .env variable names, so two names that differ only by case or punctuation would share one credential.',
          });
        }

        // Validate before touching the file: an unknown platform written to
        // sites.yaml makes loadSites throw for the ENTIRE file on next reload
        // (a server restart), taking every previously working site down with it.
        const plugin = getPlugin(a.platform);

        // Reject a missing or unknown field before writing, so a mistyped field
        // name cannot land in the file and be discovered only on next restart.
        const declared = new Set(plugin.credentialFields.map((f) => f.name));
        const missing = plugin.credentialFields
          .filter((f) => !a.credentials[f.name])
          .map((f) => f.name);
        const unknown = Object.keys(a.credentials).filter((k) => !declared.has(k));

        // A secret field's value is supposed to be the NAME of the .env
        // variable holding the real secret, not the secret itself — config.yaml
        // writes it as `${THAT_NAME}`. Reject anything that cannot possibly be
        // an env var name before it is written: `resolveEnv`'s `ENV_REF` regex
        // (src/config/sites.ts) only matches `${A-Z0-9_}`, so a malformed name
        // here would fail to match on reload and fall through to being treated
        // as the literal credential value — the site would then load as
        // "usable" with garbage credentials and no `unavailable` warning,
        // trading this immediate, clear error for a confusing auth failure
        // later at health_check or create_post time.
        const ENV_VAR_NAME = /^[A-Z0-9_]+$/;
        const invalidEnvName = plugin.credentialFields.filter(
          (f) => f.secret && a.credentials[f.name] && !ENV_VAR_NAME.test(a.credentials[f.name]!),
        );

        if (missing.length > 0 || unknown.length > 0 || invalidEnvName.length > 0) {
          throw new ToolError({
            api: 'config',
            code: 'INVALID_CREDENTIALS',
            message: [
              missing.length > 0 ? `${a.platform} needs: ${missing.join(', ')}.` : '',
              unknown.length > 0 ? `Unknown field(s): ${unknown.join(', ')}.` : '',
              ...invalidEnvName.map(
                (f) =>
                  `${f.name} (${f.label}) must be the NAME of an .env variable — letters, digits, and underscores only, e.g. UPPER_SNAKE_CASE — not the secret value itself. You passed a value that looks like it belongs in .env (something like ${f.example}), not a variable name. ${f.help}`,
              ),
            ]
              .filter(Boolean)
              .join(' '),
            hint: plugin.credentialFields
              .map(
                (f) =>
                  `${f.name} — ${f.label} (${
                    f.secret
                      ? `pass the .env variable name; value looks like ${f.example}`
                      : 'pass the value directly'
                  }). ${f.help}`,
              )
              .join('\n'),
          });
        }

        // A brand-new install has no config file at all — add_site is how the
        // FIRST site gets created, so a missing file here is the normal case,
        // not an error. An empty-but-present file parses to `null`.
        const raw = readRawSitesConfig(ctx.sitesFile) ?? { sites: {} };
        if (raw.sites[a.slug]) {
          throw new ToolError({
            api: 'config',
            code: 'SITE_EXISTS',
            message: `Site "${a.slug}" already exists. Use remove_site first to replace it.`,
          });
        }
        const block = buildSiteBlock(plugin, a.url, a.credentials, a.default_author);
        raw.sites[a.slug] = block;
        mkdirSync(dirname(ctx.sitesFile), { recursive: true });
        writeFileSync(ctx.sitesFile, stringify(raw));

        // The write above already succeeded — a completed action. Resync
        // BEFORE either return path so `ctx.sites`/`ctx.setup` reflect it, or
        // `list_sites`/`create_post` act as though `add_site` never ran.
        //
        // `loadSites` validates EVERY site in the file, not just the one we
        // just added — the platform check above only validated this site's
        // `platform`. If the file already contained a different, unrelated
        // broken site (missing `url`, an unknown platform, ...), `loadSites`
        // throws for the whole file here. That must not turn a write that
        // already succeeded into a reported failure, so it's caught: the
        // add is still reported as `ok:true`, with a warning naming the
        // other site instead of a false `ok:false` that leaves the user
        // unable to tell their new site landed.
        let warning: string | undefined;
        try {
          ctx.sites = loadSites(ctx.sitesFile, ctx.env);
          ctx.setup = buildSetupState(ctx.paths, ctx.sites, ctx.personas, [], ctx.env);
        } catch (e) {
          warning = `Site "${a.slug}" was written to ${ctx.sitesFile}, but the config could not be fully reloaded: ${
            e instanceof Error ? e.message : String(e)
          } Fix (or remove) that site and restart the server so "${a.slug}" and the rest of the config become usable again.`;
        }

        // ctx.sites/ctx.setup were left stale by the catch above, so anything
        // that reads them — including a health check for the site we just
        // added — cannot be trusted until the server restarts.
        if (warning) {
          return ok({ added: a.slug, health: null, warning });
        }

        const unset = plugin.credentialFields
          .filter((f) => f.secret && !ctx.env[a.credentials[f.name]!])
          .map((f) => a.credentials[f.name]!);
        if (unset.length > 0) {
          return ok({
            added: a.slug,
            health: null,
            note: `Site recorded. Set ${unset.map((v) => `${v}=<value>`).join(', ')} in ${ctx.paths.envFile} and restart your AI tool, then run health_check.`,
          });
        }
        return ok({ added: a.slug, health: await adapterFor(ctx, a.slug).healthCheck() });
      },
    ),
  );

  // ---- remove_site ----
  server.registerTool(
    'remove_site',
    {
      title: 'Remove site',
      description: 'Remove a publishing target from config/sites.yaml. Leaves .env untouched.',
      inputSchema: { slug: z.string() },
    },
    handler('remove_site', async (a: { slug: string }) => {
      const raw = readRawSitesConfig(ctx.sitesFile);
      if (!raw) {
        throw new ToolError({
          api: 'config',
          code: 'CONFIG_NOT_FOUND',
          message: `Cannot read site config at ${ctx.sitesFile}`,
          hint: 'There is nothing to remove yet. Run `npx @indianic/byline init`, or use add_site to create your first site.',
        });
      }
      if (!raw.sites[a.slug]) {
        throw new ToolError({
          api: 'config',
          code: 'UNKNOWN_SITE',
          message: `No site "${a.slug}". Configured: ${Object.keys(raw.sites).join(', ')}`,
        });
      }
      delete raw.sites[a.slug];
      writeFileSync(ctx.sitesFile, stringify(raw));

      // `loadSites` rejects a file that defines zero sites (a good rule for a
      // config a human just hand-edited into that state) — but removing the
      // LAST site via this tool is a legitimate, completed action, not a
      // corrupt config. Route around `loadSites` for that one case instead of
      // letting its INVALID_CONFIG throw turn a successful removal into a
      // reported failure while `ctx.setup` keeps claiming the removed site
      // still exists and is usable.
      //
      // For every other case, `loadSites` validates every REMAINING site, not
      // just the one we removed — a different, unrelated site that was
      // already broken before this call throws here too. Same reasoning as
      // `add_site`: the write already succeeded, so that must not turn into a
      // reported failure. Catch it and surface a warning instead.
      let warning: string | undefined;
      if (Object.keys(raw.sites).length === 0) {
        ctx.sites = { ...(raw.default_site ? { defaultSite: raw.default_site } : {}), sites: {} };
        ctx.setup = buildSetupState(ctx.paths, ctx.sites, ctx.personas, [], ctx.env);
      } else {
        try {
          ctx.sites = loadSites(ctx.sitesFile, ctx.env);
          ctx.setup = buildSetupState(ctx.paths, ctx.sites, ctx.personas, [], ctx.env);
        } catch (e) {
          warning = `Site "${a.slug}" was removed from ${ctx.sitesFile}, but the remaining config could not be fully reloaded: ${
            e instanceof Error ? e.message : String(e)
          } Fix (or remove) the offending site and restart the server.`;
        }
      }
      return ok({ removed: a.slug, ...(warning ? { warning } : {}) });
    }),
  );
}
