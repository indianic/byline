import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, fetchLatest, updateNotice, updateCheckDisabled } from '../../src/cli/update-check.js';
import { getPackageVersion } from '../../src/version.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wb-upd-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('isNewer', () => {
  it('compares numerically, not as strings', () => {
    // The ordinary case string comparison gets wrong: '0.10.0' < '0.9.0'
    // lexically, so a real upgrade would never be announced.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
  });

  it('handles differing segment counts', () => {
    expect(isNewer('1.1', '1.0.9')).toBe(true);
    expect(isNewer('1.0', '1.0.0')).toBe(false);
  });

  it('does not nag a stable release about a pre-release', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('is false for identical versions', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
  });
});

describe('fetchLatest', () => {
  it('asks the registry once and caches the answer', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return '9.9.9';
    };
    expect(await fetchLatest(home, 1000, run)).toBe('9.9.9');
    expect(await fetchLatest(home, 2000, run)).toBe('9.9.9');
    expect(calls).toBe(1);
  });

  it('asks again once the cache is a day old', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return '9.9.9';
    };
    await fetchLatest(home, 0, run);
    await fetchLatest(home, 25 * 60 * 60 * 1000, run);
    expect(calls).toBe(2);
  });

  it('returns null and does not throw when the registry is unreachable', async () => {
    // The current reality for an unpublished package, and the permanent
    // reality for anyone offline or behind a proxy.
    const run = async () => {
      throw new Error('npm error code E404');
    };
    await expect(fetchLatest(home, 1000, run)).resolves.toBeNull();
  });

  it('records a failed attempt so an offline user is not stalled on every command', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      throw new Error('offline');
    };
    await fetchLatest(home, 1000, run);
    await fetchLatest(home, 2000, run);
    expect(calls).toBe(1);
  });

  it('ignores a registry answer that is not a version', async () => {
    // npm can emit warnings or an HTML error page; neither is a version, and
    // announcing "upgrade to <!DOCTYPE" would be worse than silence.
    await expect(fetchLatest(home, 1000, async () => 'not a version')).resolves.toBeNull();
  });

  it('survives a corrupt cache file rather than crashing the command', async () => {
    writeFileSync(join(home, '.update-check.json'), '{not json');
    await expect(fetchLatest(home, 1000, async () => '9.9.9')).resolves.toBe('9.9.9');
  });
});

describe('updateNotice', () => {
  it('names both versions and the command that fixes it', async () => {
    const notice = await updateNotice(home, 1000, async () => '99.0.0');
    expect(notice).toContain(getPackageVersion());
    expect(notice).toContain('99.0.0');
    expect(notice).toContain('byline update');
  });

  it('says nothing when already current', async () => {
    expect(await updateNotice(home, 1000, async () => getPackageVersion())).toBeNull();
  });

  it('says nothing when the registry cannot be reached', async () => {
    expect(await updateNotice(home, 1000, async () => { throw new Error('x'); })).toBeNull();
  });
});

describe('updateCheckDisabled', () => {
  it('respects an explicit opt-out and the common CI conventions', () => {
    expect(updateCheckDisabled({ BYLINE_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    // CI is not a person; nagging a build log helps nobody and costs a round trip.
    expect(updateCheckDisabled({ CI: 'true' })).toBe(true);
    expect(updateCheckDisabled({})).toBe(false);
  });
});
