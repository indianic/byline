import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPackageName, getPackageVersion } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('version', () => {
  it('reports the published package name', () => {
    expect(getPackageName()).toBe('@indianic/byline');
  });

  it('reports the version from package.json, never a hardcoded literal', () => {
    expect(getPackageVersion()).toBe(pkg.version);
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
