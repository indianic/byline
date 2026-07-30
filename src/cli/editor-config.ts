import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPackageName } from '../version.js';

/**
 * Writes/merges the `byline` MCP server entry into each supported AI tool's
 * config file — the "one command wires up every tool" step that turns an
 * installed package into something Claude Code or Cursor actually knows about.
 *
 * The launch block carries NO secrets: credentials live in `~/.byline/.env`,
 * which the server reads itself. So the block is just `npx -y <package>`,
 * identical for every tool, and these files need no permission hardening.
 *
 * Paths mirror @indianic/mailman's verified `editor-config.ts` rather than being
 * recalled from memory — they move between tool versions, and a wrong path
 * writes a config nothing reads.
 */

export const SERVER_KEY = 'byline';
/** Read from package.json so an install always registers the name npx can actually fetch. */
export const NPM_PACKAGE = getPackageName();

export type Scope = 'global' | 'project';
export type EditorFormat = 'json' | 'toml';

export interface EditorTarget {
  id: string;
  label: string;
  format: EditorFormat;
  /** These tools only ever read a user-level config — project scope is ignored for them. */
  userLevelOnly?: boolean;
  path: (scope: Scope, cwd: string, home: string) => string;
}

export const EDITORS: EditorTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    format: 'json',
    path: (scope, cwd, home) => (scope === 'global' ? join(home, '.claude.json') : join(cwd, '.mcp.json')),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    path: (scope, cwd, home) =>
      scope === 'global' ? join(home, '.cursor', 'mcp.json') : join(cwd, '.cursor', 'mcp.json'),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    format: 'json',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.gemini', 'settings.json'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    format: 'json',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.codex', 'config.toml'),
  },
];

/**
 * Which AI tools are actually installed on this machine, judged by their
 * user-level config file existing. `init` pre-checks exactly these — offering
 * to register a tool the user does not have is noise, and writing to one they
 * did not pick is worse.
 */
export function detectInstalledEditors(home: string = homedir(), cwd: string = process.cwd()): EditorTarget[] {
  return EDITORS.filter((e) => existsSync(e.path('global', cwd, home)));
}

/** The secretless launch block every JSON-format tool gets. */
export function jsonServerBlock(): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', NPM_PACKAGE] };
}

/**
 * Pure: given a parsed config object, return a copy with the `byline` entry
 * merged into `mcpServers` (created if missing), leaving every other server and
 * top-level key untouched. Idempotent — a re-run overwrites only our own entry.
 */
export function mergeJsonMcpServers(cfg: Record<string, unknown>): Record<string, unknown> {
  const next = { ...cfg };
  const servers =
    next.mcpServers && typeof next.mcpServers === 'object'
      ? { ...(next.mcpServers as Record<string, unknown>) }
      : {};
  servers[SERVER_KEY] = jsonServerBlock();
  next.mcpServers = servers;
  return next;
}

/**
 * Pure: strip any prior `[mcp_servers.byline]` block(s) from Codex's TOML
 * and append a fresh one — so re-runs replace rather than duplicate, without
 * disturbing unrelated `[mcp_servers.*]` entries.
 */
export function mergeCodexToml(existing: string): string {
  // Line-anchored, not `[^[]*`: a `[^[]*` scan stops at the FIRST literal `[`
  // it meets, and our own block contains one — `args = ["-y", ...]` — so it
  // would truncate the strip mid-block and leave a stray remainder behind on
  // every re-run. Matching to the next line that starts with `[` (the next
  // TOML table header) or end of string strips the whole block instead.
  const stripped = existing
    .replace(/\n*^\[mcp_servers\.byline\][^\n]*\n(?:(?!^\[)[^\n]*\n?)*/gm, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  const block = `[mcp_servers.${SERVER_KEY}]\ncommand = "npx"\nargs = ["-y", "${NPM_PACKAGE}"]\n`;
  return ((stripped ? stripped + '\n\n' : '') + block).trimStart();
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} exists but isn't valid JSON — fix or remove it, then re-run.`);
  }
}

/**
 * Copy a config aside before editing it.
 *
 * One fixed `.byline-bak` rather than a timestamped series: what a user
 * wants after a bad merge is the state immediately before the most recent
 * write, and a growing pile of dated backups in `~/.claude.json`'s directory is
 * litter they never asked for.
 */
function backupFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const backup = `${file}.byline-bak`;
  copyFileSync(file, backup);
  return backup;
}

export interface WriteResult {
  label: string;
  file: string;
  action: 'created' | 'updated';
  /** Where the pre-edit content was copied, when the file already existed. */
  backup?: string;
}

/**
 * Resolve the target file for one tool + scope and write the merged config.
 *
 * No permission hardening (unlike a credentials file) — these configs hold no
 * byline secret and are shared with other tools, so their modes are left
 * alone.
 */
export function writeEditorConfig(
  editor: EditorTarget,
  scope: Scope,
  cwd: string = process.cwd(),
  home: string = homedir(),
): WriteResult {
  const effectiveScope: Scope = editor.userLevelOnly ? 'global' : scope;
  const file = editor.path(effectiveScope, cwd, home);
  const existed = existsSync(file);

  mkdirSync(dirname(file), { recursive: true });

  // Parse BEFORE backing up: an unparseable config must fail without leaving a
  // stray .byline-bak next to a file we never touched.
  const nextContent =
    editor.format === 'toml'
      ? mergeCodexToml(existed ? readFileSync(file, 'utf8') : '') + '\n'
      : JSON.stringify(mergeJsonMcpServers(readJson(file)), null, 2) + '\n';

  const backup = backupFile(file);
  writeFileSync(file, nextContent, 'utf8');

  return { label: editor.label, file, action: existed ? 'updated' : 'created', ...(backup ? { backup } : {}) };
}

/**
 * Parse a `--tools claude,cursor` / `all` spec into known tool ids (unknown
 * names dropped).
 *
 * `all` means "every tool actually installed on this machine" — the same
 * `detectInstalledEditors` check `init` already uses — NOT literally every
 * supported editor id. Before this, `all` mapped to all five unconditionally,
 * so `register --tools all` on a Claude-Code-only machine created
 * `~/.gemini/settings.json`, `~/.codeium/windsurf/mcp_config.json`, and
 * `~/.codex/config.toml` from nothing, for tools never installed — and
 * `status`/`doctor` then reported all five as registered.
 *
 * An explicitly NAMED tool (`--tools codex`) is still honoured even if
 * undetected: naming it is the user asserting it exists, which `init`'s
 * multiselect (pre-filtered to detected tools) never lets a user do — this is
 * the one path that can register an undetected tool on purpose.
 *
 * `spec` being `undefined` (a stray `--tools` with no value) resolves to
 * nothing, not "all" — silently registering every tool on a typo is worse
 * than registering none.
 */
export function resolveTools(
  spec: string | undefined,
  home: string = homedir(),
  cwd: string = process.cwd(),
): string[] {
  if (!spec) return [];
  if (spec === 'all') return detectInstalledEditors(home, cwd).map((e) => e.id);
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => EDITORS.some((e) => e.id === s));
}
