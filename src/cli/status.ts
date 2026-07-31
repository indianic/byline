import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { intro, outro } from '@clack/prompts';
import { type Context, loadContext } from '../context.js';
import { providerFamilies } from '../plugins/providers.js';
import { EDITORS, SERVER_KEY, type EditorTarget } from './editor-config.js';
import { attention, check, detail, section } from './tree.js';

/**
 * `status` — what is configured right now, and where every file lives.
 *
 * Never gated. A brand-new install with no config at all must produce useful
 * output, because "nothing is set up" is one of the answers this command
 * exists to give.
 *
 * `collectStatus` returns plain data so it can be unit-tested without a
 * terminal; the renderer below is the only part that touches stdout.
 */

export interface StatusData {
  /** One row per configured path, each with its OWN provenance. */
  paths: Array<{ label: string; path: string; source: string; via?: string }>;
  /** How the BASE directory was resolved — not how any individual file was. */
  baseSource: string;
  configured: boolean;
  sites: Array<{ slug: string; platform: string; url: string; usable: boolean; reason?: string }>;
  personas: string[];
  imageProviders: Array<{ name: string; configured: boolean; envVar: string }>;
  /** Every provider family, additive to `imageProviders` — see `collectStatus`. */
  providers: Array<{
    family: string;
    label: string;
    providers: Array<{ name: string; configured: boolean; envVar: string }>;
  }>;
  registrations: Array<{ label: string; file: string; registered: boolean; scope?: 'global' | 'project' }>;
  problems: string[];
}

/** Parse JSON, tolerating a missing or unparseable file rather than throwing. */
function readJsonSafe(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when an object's `mcpServers` (or equivalent) map names byline. */
function namesByline(container: unknown): boolean {
  if (!container || typeof container !== 'object') return false;
  const servers = (container as Record<string, unknown>).mcpServers;
  return Boolean(servers && typeof servers === 'object' && SERVER_KEY in (servers as Record<string, unknown>));
}

interface Registration {
  registered: boolean;
  file: string;
  scope?: 'global' | 'project';
}

/**
 * Where (if anywhere) this editor's config actually names byline.
 *
 * Checks three places, not just the global file:
 *  1. The global config (`~/.claude.json`, `~/.cursor/mcp.json`, ...).
 *  2. For Claude Code specifically, the project-scoped ("local") registration
 *     Claude Code itself stores INSIDE that same global file, under
 *     `projects[<cwd>].mcpServers` — a different shape, not a different file.
 *     This is where the maintainer's own registration actually lived, and the
 *     old check (global `mcpServers` only) reported it absent (Finding 4).
 *  3. The project-scope FILE `byline register --scope project` writes
 *     (`<cwd>/.mcp.json`, `<cwd>/.cursor/mcp.json`) for tools that support it.
 */
function findRegistration(editor: EditorTarget, cwd: string, home: string): Registration {
  const globalFile = editor.path('global', cwd, home);

  if (editor.format === 'toml') {
    if (existsSync(globalFile)) {
      try {
        if (readFileSync(globalFile, 'utf8').includes(`[mcp_servers.${SERVER_KEY}]`)) {
          return { registered: true, file: globalFile, scope: 'global' };
        }
      } catch {
        // Unreadable — fall through to "not registered" rather than throw.
      }
    }
    return { registered: false, file: globalFile };
  }

  const globalParsed = readJsonSafe(globalFile);
  if (namesByline(globalParsed)) {
    return { registered: true, file: globalFile, scope: 'global' };
  }

  if (editor.id === 'claude') {
    const projects = globalParsed?.projects as Record<string, unknown> | undefined;
    if (namesByline(projects?.[cwd])) {
      return { registered: true, file: globalFile, scope: 'project' };
    }
  }

  if (!editor.userLevelOnly) {
    const projectFile = editor.path('project', cwd, home);
    if (projectFile !== globalFile && namesByline(readJsonSafe(projectFile))) {
      return { registered: true, file: projectFile, scope: 'project' };
    }
  }

  return { registered: false, file: globalFile };
}

export function collectStatus(
  ctx: Context,
  home: string = homedir(),
  cwd: string = process.cwd(),
): StatusData {
  const p = ctx.paths.provenance;

  return {
    baseSource: ctx.paths.source,
    // Each row carries the provenance of THAT path. Printing one global source
    // would be wrong for any path a BYLINE_* variable pointed elsewhere.
    paths: [
      { label: 'config', ...p.configFile },
      { label: 'personas', ...p.personasDir },
      { label: 'secrets', ...p.envFile },
      { label: 'images', ...p.runsDir },
    ],
    configured: ctx.setup.configured,
    sites: Object.values(ctx.sites.sites).map((s) => ({
      slug: s.slug,
      platform: s.platform,
      url: s.url,
      usable: !s.unavailable,
      // Never the credential itself — `unavailable` names the missing VARIABLE.
      ...(s.unavailable ? { reason: s.unavailable } : {}),
    })),
    personas: [...ctx.personas.keys()].sort(),
    // `imageProviders` is consumed output — kept exactly as it was so nothing
    // reading this field breaks. `providers` below is the additive, family-
    // generic replacement every NEW consumer should read instead.
    imageProviders: providerFamilies()
      .filter((f) => f.id === 'images')
      .flatMap((f) => f.providers(ctx.env))
      .map((provider) => ({
        name: provider.name,
        configured: provider.configured(),
        envVar: provider.credential.name,
      })),
    // Walked through the family descriptor, one entry per family, with no
    // family named here — this is what makes registering a new family in
    // `src/plugins/providers.ts` show up in `status` for free.
    providers: providerFamilies().map((family) => ({
      family: family.id,
      label: family.label,
      providers: family.providers(ctx.env).map((provider) => ({
        name: provider.name,
        configured: provider.configured(),
        envVar: provider.credential.name,
      })),
    })),
    registrations: EDITORS.map((e) => {
      const reg = findRegistration(e, cwd, home);
      return { label: e.label, file: reg.file, registered: reg.registered, ...(reg.scope ? { scope: reg.scope } : {}) };
    }),
    problems: ctx.setup.problems,
  };
}

export async function runStatus(_args: string[]): Promise<void> {
  const data = collectStatus(loadContext());

  intro('byline — status');

  section(`paths   (base resolved from: ${data.baseSource})`);
  for (const row of data.paths) {
    const origin = row.via ? `${row.source} via ${row.via}` : row.source;
    detail(`${row.label.padEnd(9)} ${row.path}   [${origin}]`);
  }

  section('blogs');
  if (data.sites.length === 0) {
    detail('none configured — run `byline init`');
  } else {
    for (const s of data.sites) {
      check(s.usable, `${s.slug.padEnd(12)} ${s.platform.padEnd(10)} ${s.url}`);
      if (s.reason) detail(`  ${s.reason}`);
    }
  }

  section('authors');
  detail(data.personas.length > 0 ? data.personas.join(', ') : 'none — add a persona file to the personas directory');

  // One section per family, heading taken from the family descriptor — no
  // family is named here, so a new family registered in
  // `src/plugins/providers.ts` shows up in this output for free.
  for (const family of data.providers) {
    section(family.label);
    for (const provider of family.providers) {
      check(provider.configured, `${provider.name.padEnd(9)} ${provider.configured ? 'key set' : `${provider.envVar} not set`}`);
    }
  }

  section('AI tools');
  for (const r of data.registrations) {
    // Naming WHERE a registration was found matters now that it can be at
    // project scope, or (for Claude Code) inside `projects[<cwd>]` in the same
    // global file — "registered" alone no longer says where (Finding 4).
    check(r.registered, `${r.label.padEnd(13)} ${r.registered ? `registered [${r.scope ?? 'global'}] — ${r.file}` : 'not registered'}`);
  }

  if (data.problems.length > 0) {
    section('problems');
    for (const problem of data.problems) attention(problem);
  }

  outro(data.configured ? 'Ready to publish.' : 'Not configured yet — run `byline init`.');
}
