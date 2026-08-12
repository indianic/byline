import pc from 'picocolors';
import { ToolError } from '../errors.js';

/**
 * The shared terminal-tree vocabulary every human-facing command renders
 * through, so `status` / `doctor` / `help` all look like one tool — and like
 * @indianic/mailman, whose glyph vocabulary this reproduces deliberately so the
 * two read as one suite.
 *
 * Rows are written directly rather than through @clack/prompts' `log.*`
 * helpers: clack emits a spacer `│` line before EVERY message, which
 * double-spaces lists. Here consecutive rows touch, and the single blank
 * connector line comes before each ◆ section header and nowhere else.
 * `intro()` / `outro()` stay clack's — those already render correctly.
 */

const BAR = pc.gray('│');

/** Prefix continuation lines of a multi-line message so the tree's rail stays unbroken. */
function writeRow(glyph: string, text: string): void {
  const [first, ...rest] = text.split('\n');
  process.stdout.write(`${glyph}  ${first}\n`);
  for (const line of rest) {
    process.stdout.write(`${BAR}  ${line}\n`);
  }
}

/** Top-level section header — a blank rail line for breathing room, then a filled ◆. */
export function section(title: string): void {
  process.stdout.write(`${BAR}\n`);
  writeRow(pc.green('◆'), title);
}

/** A single pass/fail fact nested under a section. Hollow ◇ when ok, red ■ when not. */
export function check(ok: boolean, text: string): void {
  writeRow(ok ? pc.green('◇') : pc.red('■'), text);
}

/** Worth flagging without being a hard failure — yellow ▲. */
export function attention(text: string): void {
  writeRow(pc.yellow('▲'), text);
}

/** An error or usage failure — red ■. */
export function fail(text: string): void {
  writeRow(pc.red('■'), text);
}

/** Informational guidance mid-flow — blue ●. */
export function info(text: string): void {
  writeRow(pc.blue('●'), text);
}

/** Plain data line — no icon, just the rail. Consecutive details touch. */
export function detail(text: string): void {
  writeRow(BAR, text);
}

/**
 * Render a caught error in this vocabulary: the message, a `ToolError`'s hint,
 * and the stack only behind `BYLINE_DEBUG`.
 *
 * The ONE definition of that rendering, and it lives here rather than in
 * `main.ts` because it has two callers with different framing.
 * `reportUnexpectedFailure` (`main.ts`) is the top-level boundary and adds its
 * own `outro` and exit code; `runMedia` (`media.ts`) catches inside a command
 * that has already opened its own `intro`, so it supplies its own closing line.
 * They were two hand-copies before, and they had already drifted — which is
 * exactly what `one rule, one definition` exists to stop. Putting it here also
 * keeps `media.ts` from importing `main.ts`, which imports `media.ts`.
 *
 * A `ToolError`'s `hint` is always rendered: that field exists to say what to
 * do next, and dropping it discards the most useful part of the error. The
 * stack is not discarded either — it is one `BYLINE_DEBUG=1` re-run away, so a
 * non-technical user is never shown `mkdirSync` internals and a developer never
 * loses them.
 */
export function renderFailure(err: unknown): void {
  if (err instanceof ToolError) {
    fail(err.message);
    if (err.hint) info(err.hint);
  } else {
    fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (process.env.BYLINE_DEBUG) {
    const stack = err instanceof Error ? err.stack : undefined;
    if (stack) detail(stack);
  } else {
    info('Set BYLINE_DEBUG=1 and re-run for the full stack trace.');
  }
}
