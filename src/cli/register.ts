import { cancel, intro, isCancel, multiselect, outro, select } from '@clack/prompts';
import {
  EDITORS,
  NPM_PACKAGE,
  detectInstalledEditors,
  resolveTools,
  writeEditorConfig,
  type Scope,
} from './editor-config.js';
import { requireTty } from './interactive.js';
import { detail, fail, info, section } from './tree.js';

/**
 * The tool picker shared by `init` and `register -i`.
 *
 * Only the tools actually installed on this machine are offered, and they are
 * all pre-selected — the common case is "yes, all of them". A tool the user
 * deselects is never written to. Returns the ids actually written, so callers
 * can tailor their closing message.
 */
export async function promptAndWriteEditorConfigs(defaultScope: Scope = 'global'): Promise<string[]> {
  const found = detectInstalledEditors();

  if (found.length === 0) {
    info(
      'No AI tool configs found on this machine (looked for Claude Code, Cursor, Windsurf, Gemini CLI, and Codex).\n' +
        `Register manually later with: claude mcp add byline -- npx -y ${NPM_PACKAGE}`,
    );
    return [];
  }

  const picked = await multiselect({
    message: 'Register byline with which AI tools? (space to toggle, enter to confirm)',
    options: found.map((e) => ({ value: e.id, label: e.label })),
    initialValues: found.map((e) => e.id),
    required: false,
  });
  if (isCancel(picked)) {
    cancel('Cancelled.');
    process.exit(1);
  }
  const tools = picked as string[];
  if (tools.length === 0) return [];

  // Only ask about scope if a picked tool actually honors it — Gemini,
  // Windsurf, and Codex are user-level only, so the question would be noise.
  let scope: Scope = defaultScope;
  if (tools.some((id) => !EDITORS.find((e) => e.id === id)?.userLevelOnly)) {
    const chosen = await select({
      message: 'Config scope',
      options: [
        { value: 'global', label: 'Global — available in every project (recommended)' },
        { value: 'project', label: 'This project only — writes into the current folder' },
      ],
      initialValue: defaultScope,
    });
    if (isCancel(chosen)) {
      cancel('Cancelled.');
      process.exit(1);
    }
    scope = chosen as Scope;
  }

  return writeSelectedEditors(tools, scope);
}

/** Non-interactive core: write configs for the given tool ids, printing a tree summary. */
export function writeSelectedEditors(toolIds: string[], scope: Scope): string[] {
  const written: string[] = [];
  section('AI tool config');
  for (const id of toolIds) {
    const editor = EDITORS.find((e) => e.id === id);
    if (!editor) continue;
    try {
      const result = writeEditorConfig(editor, scope);
      detail(`${result.label}: ${result.action} ${result.file}`);
      if (result.backup) detail(`  backup: ${result.backup}`);
      written.push(id);
    } catch (err) {
      fail(`${editor.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}

/**
 * `byline register` — three modes:
 *  - bare: print the copy-pasteable `claude mcp add …` line (plain, no glyphs,
 *    because the whole point is selecting and pasting it)
 *  - `--tools <a,b|all> [--scope global|project]`: non-interactive
 *  - `--interactive` / `-i`: the multiselect wizard
 */
export async function runRegister(args: string[]): Promise<void> {
  const toolsIdx = args.indexOf('--tools');
  const scopeIdx = args.indexOf('--scope');
  const interactive = args.includes('--interactive') || args.includes('-i');
  const scope: Scope = scopeIdx >= 0 && args[scopeIdx + 1] === 'project' ? 'project' : 'global';

  if (toolsIdx >= 0) {
    intro('byline — register');
    const written = writeSelectedEditors(resolveTools(args[toolsIdx + 1]), scope);
    outro(
      written.length > 0
        ? `Registered with ${written.length} tool(s). Restart them to load byline.`
        : 'No known tools matched — nothing written.',
    );
    return;
  }

  if (interactive) {
    intro('byline — register');
    requireTty(
      '`byline register -i`',
      'Non-interactive alternative: byline register --tools claude,cursor [--scope global|project]',
    );
    const written = await promptAndWriteEditorConfigs(scope);
    outro(
      written.length > 0
        ? `Registered with ${written.length} tool(s). Restart them to load byline.`
        : 'Nothing selected — no changes made.',
    );
    return;
  }

  process.stdout.write(`claude mcp add byline -- npx -y ${NPM_PACKAGE}\n`);
}

export { resolveTools };
