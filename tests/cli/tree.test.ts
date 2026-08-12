import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attention, check, detail, fail, info, renderFailure, section } from '../../src/cli/tree.js';
import { ToolError } from '../../src/errors.js';

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// picocolors' isColorSupported turns colour ON whenever process.env.CI is
// truthy (GitHub Actions, GitLab CI, and CircleCI all set it), regardless of
// whether stdout is a TTY. Under CI, writeRow() emits e.g.
// `\x1b[31m■\x1b[39m  text`, putting a reset escape between the glyph and the
// two spaces before the text. Stripping ANSI escapes here lets these
// assertions verify the real glyph-then-text output in both colour and
// no-colour environments, without weakening what they check. Do not remove
// this — without it, these tests are green locally but red in CI.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const output = () => written.join('').replace(ANSI_PATTERN, '');

describe('tree', () => {
  it('prefixes a section with a blank rail line and a filled diamond', () => {
    section('paths');
    expect(output()).toContain('│\n');
    expect(output()).toContain('◆  paths');
  });

  it('renders a passing check with a hollow diamond and a failing one with a filled square', () => {
    check(true, 'Node v22.1.0');
    check(false, 'Ghost unreachable');
    expect(output()).toContain('◇  Node v22.1.0');
    expect(output()).toContain('■  Ghost unreachable');
  });

  it('uses a triangle for attention and a circle for info', () => {
    attention('.env is world-readable');
    info('Run `byline init`');
    expect(output()).toContain('▲  .env is world-readable');
    expect(output()).toContain('●  Run `byline init`');
  });

  it('renders a failure row with a filled square', () => {
    fail('Unknown command: statuss');
    expect(output()).toContain('■  Unknown command: statuss');
  });

  it('keeps the rail unbroken across a multi-line message', () => {
    detail('first\nsecond\nthird');
    const lines = output().trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('│  second');
    expect(lines[2]).toContain('│  third');
  });
});

// The one definition of how a caught error is rendered, shared by main.ts's
// top-level boundary and runMedia's own catch. They were two hand-copies that
// had already drifted.
describe('renderFailure', () => {
  const savedDebug = process.env.BYLINE_DEBUG;
  afterEach(() => {
    // Restore per key — never `process.env = { ...saved }`.
    if (savedDebug === undefined) delete process.env.BYLINE_DEBUG;
    else process.env.BYLINE_DEBUG = savedDebug;
  });

  it("renders a ToolError's message AND its hint", () => {
    delete process.env.BYLINE_DEBUG;
    renderFailure(
      new ToolError({ api: 'media', code: 'NOPE', message: 'It went wrong.', hint: 'Do this instead.' }),
    );
    expect(output()).toContain('■  It went wrong.');
    expect(output()).toContain('●  Do this instead.');
  });

  it('hides the stack behind BYLINE_DEBUG rather than discarding it', () => {
    delete process.env.BYLINE_DEBUG;
    renderFailure(new Error('boom'));
    expect(output()).toContain('■  Unexpected error: boom');
    expect(output()).not.toMatch(/at Object\.|node:internal/);
    expect(output()).toContain('BYLINE_DEBUG=1');
  });

  it('prints the stack when BYLINE_DEBUG is set', () => {
    process.env.BYLINE_DEBUG = '1';
    renderFailure(new Error('boom'));
    // The rail prefixes every continuation line, so the stack arrives as
    // `│  Error: boom` followed by `│      at …`.
    expect(output()).toContain('│  Error: boom');
    expect(output()).toMatch(/│\s+at /);
    expect(output()).not.toContain('BYLINE_DEBUG=1');
  });
});
