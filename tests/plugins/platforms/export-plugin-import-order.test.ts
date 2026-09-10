// Regression test for a real circular-import defect found while building the
// export platforms: `plugins/platforms/export/adapter.ts` reuses
// `media/library.ts`'s `expandPath`, and `media/library.ts` used to import
// `SLUG_PATTERN`/`SLUG_RULE` from `config/sites.ts`, which imports the whole
// plugin registry — closing a cycle (media/library.ts -> config/sites.ts ->
// registry.ts -> an export platform's plugin.ts -> export/adapter.ts ->
// media/library.ts). Whichever module in that cycle is imported FIRST
// decides which one gets re-entered mid-initialization; importing an export
// platform's plugin.ts directly, before anything has touched config/sites.ts,
// used to throw "Cannot access 'mediumPlugin' before initialization" —
// registry.ts's own top-level `PLATFORM_PLUGINS` object literal dereferencing
// a binding that was still in the temporal dead zone.
//
// The fix moved SLUG_PATTERN/SLUG_RULE into their own `config/slug.ts`, which
// `media/library.ts` now imports instead — severing media/library.ts's
// dependency on config/sites.ts (and therefore on the registry) entirely.
//
// These imports are written FIRST and in THIS order deliberately: nothing
// in this file touches `config/sites.js` or `plugins/registry.js` before
// these three lines run, which is exactly the import order that triggered
// the defect.
import { mediumPlugin } from '../../../src/plugins/platforms/medium/plugin.js';
import { substackPlugin } from '../../../src/plugins/platforms/substack/plugin.js';
import { linkedinArticlePlugin } from '../../../src/plugins/platforms/linkedin-article/plugin.js';
import { describe, expect, it } from 'vitest';

describe('an export platform plugin file, imported standalone', () => {
  it('loads without a circular-import ReferenceError, before anything touches config/sites.js', () => {
    expect(mediumPlugin.id).toBe('medium');
    expect(substackPlugin.id).toBe('substack');
    expect(linkedinArticlePlugin.id).toBe('linkedin-article');
  });
});
