import { readFileSync } from 'node:fs';

/**
 * package.json, resolved relative to this module: `dist/version.js` →
 * `dist/../package.json`. Works identically from `src/` under tsx and from
 * `dist/` in a published install, because both sit exactly one level below the
 * package root.
 */
function readPackageJson(): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
}

/**
 * The installed version, read at runtime rather than hardcoded — a literal here
 * is how a package ships '0.1.0' through five releases. Used by the MCP
 * initialize handshake, `byline --version`, and `byline update`.
 */
export function getPackageVersion(): string {
  return readPackageJson().version;
}

/**
 * The installed package *name*. Anything that npx-resolves or registry-queries
 * this package — editor MCP configs, `byline update` — must use whichever
 * name this install was actually published under, never a hardcoded literal.
 */
export function getPackageName(): string {
  return readPackageJson().name;
}
