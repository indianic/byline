import { intro, outro } from '@clack/prompts';
import { detail, fail, info, section } from './tree.js';
import { runInit } from './init.js';
import { runRegister } from './register.js';
import { runStatus } from './status.js';
import { runDoctor } from './doctor.js';
import { runMigrate } from './migrate.js';
import { runReset } from './reset.js';
import { runUpdate } from './update.js';
import { getPackageVersion } from '../version.js';
import { resolvePaths } from '../config/paths.js';
import { updateCheckDisabled, updateNotice } from './update-check.js';
import { ToolError } from '../errors.js';

type CommandHandler = (args: string[]) => Promise<void>;

interface CommandEntry {
  /** null = registered in the surface but not implemented yet. */
  handler: CommandHandler | null;
  summary: string;
}

/**
 * The full command surface. Entries land as `null` and are filled in by their
 * own task, so `help` and the unknown-command error stay accurate at every
 * commit rather than promising commands that do nothing.
 */
const COMMANDS: Record<string, CommandEntry> = {
  init: { handler: runInit, summary: 'First-run wizard: register your AI tools and add your first blog' },
  status: { handler: runStatus, summary: 'What is configured right now, and where each file lives' },
  doctor: { handler: runDoctor, summary: 'Probe every configured API and print a fix per failure' },
  register: { handler: runRegister, summary: 'Register with AI tools (--tools <a,b|all> [--scope], -i, or bare to print the command)' },
  migrate: { handler: runMigrate, summary: 'Copy a repo-local config into ~/.byline/' },
  reset: { handler: runReset, summary: 'Wipe ~/.byline/ (--yes required)' },
  update: { handler: runUpdate, summary: 'Self-update the global install to the latest version' },
  upgrade: { handler: runUpdate, summary: 'Alias of `update`' },
  help: { handler: async (args) => printHelp(args[0]), summary: 'This list (or `help <command>`)' },
};

function printHelp(commandName?: string): void {
  intro('byline — help');

  if (commandName) {
    const entry = COMMANDS[commandName];
    if (entry) {
      section(commandName);
      detail(`byline ${commandName.padEnd(12)} ${entry.summary}`);
      outro('`byline help` — the full list');
      return;
    }
    fail(`Unknown command: ${commandName} — showing the full list.`);
  }

  section('commands   (usage: byline <command> [...args])');
  for (const [name, entry] of Object.entries(COMMANDS)) {
    const tag = entry.handler ? '' : ' (not implemented yet)';
    detail(`${name.padEnd(12)} ${entry.summary}${tag}`);
  }
  section('flags');
  detail('--version    Print the installed version');
  detail('--help       This list');
  outro('New here? Run `byline init`.');
}

// Plain dynamic-programming edit distance — a handful of short command names,
// so nothing cleverer is warranted.
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * Nearest known command within edit distance 2 (typo range), or null when
 * nothing is plausibly close. Exported for unit tests.
 */
export function suggestCommand(input: string, names: string[] = Object.keys(COMMANDS)): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const name of names) {
    const d = levenshtein(input.toLowerCase(), name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

export async function runCli(args: string[]): Promise<void> {
  const [first] = args;

  // Bare value, no tree decoration — scripts parse this.
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${getPackageVersion()}\n`);
    return;
  }

  if (!first || first === '--help' || first === '-h') {
    printHelp();
    return;
  }

  const entry = COMMANDS[first];

  if (!entry) {
    const hint = suggestCommand(first);
    intro('byline');
    fail(`Unknown command: ${first}${hint ? `\nDid you mean \`byline ${hint}\`?` : ''}`);
    outro('Run `byline help` for the full command list.');
    process.exitCode = 1;
    return;
  }

  if (!entry.handler) {
    intro('byline');
    fail(`\`${first}\` is planned but not implemented yet.`);
    outro('Run `byline help` for the full command list.');
    process.exitCode = 1;
    return;
  }

  try {
    await entry.handler(args.slice(1));
  } catch (err) {
    reportUnexpectedFailure(err);
  }

  await announceUpdate(first);
}

/**
 * Tell the user when a newer version exists, after their command has finished.
 *
 * Deliberately last, and deliberately quiet:
 *
 *  - It never runs for `--version`, which returns earlier — scripts parse that
 *    output, and a courtesy line would corrupt it.
 *  - It never runs for the MCP server, because the shim only reaches `runCli`
 *    for a human at a terminal. A stray line on stdout would be framed as a
 *    protocol message and break the host.
 *  - It never runs for `update` itself, which already reports versions and
 *    would otherwise contradict itself mid-command.
 *  - It runs AFTER the command, so a slow registry delays a notice rather than
 *    the work the user actually asked for.
 *  - Every failure is swallowed. A version notice must never be the reason a
 *    command fails.
 */
async function announceUpdate(command: string): Promise<void> {
  if (command === 'update' || command === 'upgrade') return;
  if (updateCheckDisabled()) return;
  try {
    const notice = await updateNotice(resolvePaths().home);
    if (notice) info(notice);
  } catch {
    // Unreachable in practice — updateNotice already swallows everything — but
    // this is the last line before a user's terminal, so it does not get to be
    // the thing that throws.
  }
}

/**
 * Last-resort error boundary around every command handler.
 *
 * Without this, ANY thrown error — a guard elsewhere missed a case, or a
 * future command simply doesn't guard something yet — reaches the bin shim's
 * top-level `.catch()` as a raw Node stack trace. That is precisely the
 * experience this CLI exists to spare a non-technical user from: it is meant
 * to get someone set up, not teach them to read `mkdirSync` internals.
 *
 * A thrown `ToolError`'s `hint` is rendered — that field exists specifically
 * to tell the user what to do next, and dropping it here would discard the
 * most useful part of the error. For anything else, only the message is shown
 * by default: the stack is real diagnostic value for whoever debugs the
 * underlying bug, but noise for someone who just wants their setup fixed.
 * Rather than deleting that value, it is gated behind `BYLINE_DEBUG` (set
 * to anything truthy) so it is one re-run away, never silently gone.
 */
export function reportUnexpectedFailure(err: unknown): void {
  if (err instanceof ToolError) {
    fail(err.message);
    if (err.hint) info(err.hint);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Unexpected error: ${message}`);
  }

  if (process.env.BYLINE_DEBUG) {
    const stack = err instanceof Error ? err.stack : undefined;
    if (stack) detail(stack);
  } else {
    info('Set BYLINE_DEBUG=1 and re-run for the full stack trace.');
  }

  outro('byline hit an unexpected error.');
  process.exitCode = 1;
}
