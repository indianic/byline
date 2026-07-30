import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attention, check, detail, fail, info, section } from '../../src/cli/tree.js';

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
