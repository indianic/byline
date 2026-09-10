/**
 * The one definition of a legal site slug, for both writers of `config.yaml`.
 *
 * Lives in its own file, separate from `config/sites.ts`, on purpose:
 * `config/sites.ts` imports the plugin registry (`getPlugin`) to validate
 * each site's credential block, and the plugin registry imports every
 * platform including the export platforms, whose `ExportAdapter` needs
 * `src/media/library.ts`'s `expandPath` helper. If this pattern lived in
 * `config/sites.ts`, `media/library.ts` importing it would close a real
 * import cycle (`media/library.ts` → `config/sites.ts` → `plugins/registry.ts`
 * → an export platform's `plugin.ts` → `plugins/platforms/export/adapter.ts`
 * → `media/library.ts`) — harmless in the one import order this codebase's
 * own entry point and test suite happen to exercise today, but a genuine
 * `ReferenceError` ("Cannot access '...' before initialization") waiting for
 * whichever future test or script imports an export platform's `plugin.ts`
 * directly before anything has loaded `config/sites.ts`. `config/sites.ts`
 * re-exports this so every existing import of `SLUG_PATTERN`/`SLUG_RULE` from
 * `'../config/sites.js'` keeps working unchanged.
 *
 * `envVarNameFor` (`src/cli/home-config.ts`) uppercases a slug and collapses
 * every non-alphanumeric run to `_`, so `my-blog` and `my_blog` both produce
 * `MY_BLOG_*` — two sites silently sharing one credential env var, where
 * adding the second overwrites the first's key. Restricting the alphabet to
 * lowercase alphanumerics and hyphens makes that collision unreachable rather
 * than merely unlikely, and guarantees the derived name matches `ENV_REF`
 * (`config/sites.ts`) (a name outside `[A-Z0-9_]` fails to match on reload,
 * and the `${…}` text is then treated as a LITERAL credential).
 *
 * Both writers enforce THIS constant — `add_site`'s input schema and the CLI's
 * `promptSlug`. They already disagreed once, when only the CLI checked; a
 * second hand-written copy of the regex is how that happens again.
 *
 * Deliberately NOT enforced by `loadSites`: an existing config with an
 * unconventional slug keeps working. This constrains what gets written from
 * here on, and does not invalidate what someone already has on disk.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The human-facing statement of {@link SLUG_PATTERN}, shared by both writers. */
export const SLUG_RULE =
  'Use lowercase letters, digits, and hyphens only, starting with a letter or digit — e.g. "personal" or "company-blog".';
