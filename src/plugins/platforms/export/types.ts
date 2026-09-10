import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * Describes one export-only platform: a site with no publishing API, whose
 * `ExportAdapter` writes a folder of hand-off material to the filesystem
 * instead of calling a remote API. Medium, Substack, and LinkedIn Article all
 * resolve to one of these — see `src/plugins/platforms/medium/plugin.ts` for
 * how a plugin wires one up (`makeAdapter: (site) => new ExportAdapter(site, MEDIUM_SPEC)`).
 */
export interface ExportSpec {
  /** Lowercase machine id, e.g. `'medium'`. Matches `PlatformPlugin.id`. */
  platformId: string;
  /** Human-readable display name, e.g. `'Medium'`. Never `platformId` — see `HtmlProfile.label`'s doc comment for why. */
  label: string;
  /** Numbered, platform-specific paste steps shown on the hand-off page. */
  pasteSteps: readonly string[];
  /**
   * What the editor does to pasted HTML. Every export profile has
   * `verified: false` — nothing here has been confirmed by a live paste, only
   * reasoned from the editor's known behaviour. See each profile's `notes`.
   */
  profile: HtmlProfile;
}
