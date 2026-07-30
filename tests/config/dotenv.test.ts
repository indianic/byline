import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvPermissions, loadEnvFile, parseEnv } from '../../src/config/dotenv.js';

describe('parseEnv', () => {
  it('parses plain key=value pairs', () => {
    expect(parseEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('ignores blank lines and comments', () => {
    expect(parseEnv('# note\n\nA=1\n   # indented\n')).toEqual({ A: '1' });
  });

  it('strips surrounding double and single quotes', () => {
    expect(parseEnv('A="hello world"\nB=\'x y\'')).toEqual({ A: 'hello world', B: 'x y' });
  });

  it('keeps a colon-separated Ghost key intact', () => {
    // Ghost admin keys are id:secret. A naive split on ':' would corrupt them.
    expect(parseEnv('K=abc:def')).toEqual({ K: 'abc:def' });
  });

  it('accepts an export prefix', () => {
    expect(parseEnv('export A=1')).toEqual({ A: '1' });
  });

  it('strips a trailing inline comment from an unquoted value', () => {
    expect(parseEnv('A=1 # trailing')).toEqual({ A: '1' });
  });

  it('keeps a hash inside a quoted value', () => {
    expect(parseEnv('A="a#b"')).toEqual({ A: 'a#b' });
  });

  it('unescapes a backslash-escaped double quote inside a double-quoted value', () => {
    // This is what upsertEnvVars' formatEnvValue writes for a value
    // containing a `"` — the reader must undo it for the value to round-trip.
    expect(parseEnv('A="He said \\"hi\\" to me"')).toEqual({ A: 'He said "hi" to me' });
  });

  it('skips lines with no equals sign and invalid keys', () => {
    expect(parseEnv('nonsense\n9BAD=1\nGOOD=2')).toEqual({ GOOD: '2' });
  });
});

describe('loadEnvFile', () => {
  it('does not overwrite a variable already set in the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'A=from-file\nB=from-file');
    const env: NodeJS.ProcessEnv = { A: 'from-shell' };
    loadEnvFile(file, env);
    // The MCP registration must be able to override the file.
    expect(env.A).toBe('from-shell');
    expect(env.B).toBe('from-file');
  });

  it('is silent when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadEnvFile('/nonexistent/path/.env', env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe('checkEnvPermissions', () => {
  it('returns null for a missing file', () => {
    expect(checkEnvPermissions('/nonexistent/path/.env')).toBeNull();
  });

  it('returns null for a 600 file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-perm-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1');
    chmodSync(file, 0o600);
    expect(checkEnvPermissions(file)).toBeNull();
  });

  it('warns when the file is group- or world-readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-perm-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1');
    chmodSync(file, 0o644);
    const warning = checkEnvPermissions(file);
    expect(warning).toContain('644');
    expect(warning).toContain('chmod 600');
  });
});
