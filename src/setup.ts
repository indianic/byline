import type { Context } from './context.js';
import { ToolError } from './errors.js';
import type { Paths } from './config/paths.js';

/** What a tool needs before it can do anything useful. */
export type Requirement = 'sites' | 'personas' | 'images';

export interface SetupState {
  /** True when at least one site is usable — the minimum bar for publishing. */
  configured: boolean;
  paths: Paths;
  siteCount: number;
  usableSiteCount: number;
  personaCount: number;
  /** Image providers whose API key is present. */
  imageProviders: string[];
  /** Research providers whose API key is present. */
  researchProviders: string[];
  /** Human-readable reasons setup is incomplete. Surfaced verbatim by doctor. */
  problems: string[];
  /** Subset of `problems` about sites specifically: a site's unset key. Config load
   *  failures go into the top-level `problems` (via `extraProblems`) instead, since
   *  they aren't about any one site. */
  siteProblems: string[];
}

/**
 * Exported so any first-contact error — not just the ones raised from this
 * file — can point a brand-new user (who by definition has no checkout) at the
 * one command that actually gets them going, instead of checkout-era advice
 * like "copy config/sites.yaml from the repo". See `src/config/sites.ts`'s
 * `CONFIG_NOT_FOUND` hint.
 */
export const INIT_HINT =
  'Run `npx @indianic/byline init` in a terminal, or ask me to run `byline doctor` to see what is missing.';

/**
 * Refuse a tool call that cannot possibly succeed, with a message naming the fix.
 *
 * Throws rather than returning, because every tool handler already funnels
 * thrown values through `fail()` into the ToolError envelope.
 *
 * Never call this from `health_check` — the diagnostic path has to work in
 * exactly the broken state that makes someone reach for it.
 */
export function requireSetup(ctx: Context, need: Requirement): void {
  const s = ctx.setup;

  if (need === 'sites') {
    if (s.siteCount === 0) {
      throw new ToolError({
        api: 'config',
        code: 'SETUP_INCOMPLETE',
        message: `byline is not configured yet. No sites are set up in ${s.paths.configFile}.`,
        hint: INIT_HINT,
      });
    }
    if (s.usableSiteCount === 0) {
      // A different failure entirely: the config is fine, a key is missing. Sending
      // this user back to `init` would waste their time. Name the env var instead.
      throw new ToolError({
        api: 'config',
        code: 'SETUP_INCOMPLETE',
        message: `All ${s.siteCount} configured site(s) are unusable: ${s.siteProblems.join(' ')}`,
        hint: `Set the missing environment variable in ${s.paths.envFile} and restart your AI tool, or run \`byline doctor\`.`,
      });
    }
    return;
  }

  if (need === 'personas') {
    if (s.personaCount === 0) {
      throw new ToolError({
        api: 'config',
        code: 'SETUP_INCOMPLETE',
        message: `No author personas are configured in ${s.paths.personasDir}.`,
        hint: `Copy \`personas/_template.yaml\` to ${s.paths.personasDir}/<your-name>.yaml and fill it in, or run \`npx @indianic/byline init\`.`,
      });
    }
    return;
  }

  if (need === 'images') {
    if (s.imageProviders.length === 0) {
      throw new ToolError({
        api: 'config',
        code: 'SETUP_INCOMPLETE',
        message: 'No image provider is configured, so no image can be generated.',
        hint: `Set GEMINI_API_KEY (or XAI_API_KEY) in ${s.paths.envFile}, then restart your AI tool. ${INIT_HINT}`,
      });
    }
  }
}
