import { defaultChain } from './images/index.js';
import type { ProviderFamily } from './provider.js';
import { researchProviders } from './research/index.js';

const IMAGES: ProviderFamily = {
  id: 'images',
  label: 'image generation',
  initPrompt: 'Set up AI image generation for hero images? (optional)',
  unconfiguredNote: 'not a failure — the second image provider is a fallback most users skip',
  providers: (env) => defaultChain(env),
};

const RESEARCH: ProviderFamily = {
  id: 'research',
  label: 'research',
  initPrompt: 'Set up a research provider for news articles? (optional — most agents already have web access)',
  // Deliberately says nothing about a fallback. Brave and Tavily return
  // different shapes and Byline never substitutes one for the other, so the
  // images wording would be a false promise here. See ProviderFamily.
  unconfiguredNote: 'not a failure — research is optional, and one provider is enough (Byline never substitutes the other)',
  providers: (env) => researchProviders(env),
};

/**
 * Every provider family, in the order the installer offers them.
 *
 * The ONE place a family is registered. `init`, `doctor`, and `status` all walk
 * this list, so adding a family is one entry here and no edit under `src/cli/`.
 *
 * Takes NO environment, deliberately. Which families exist is fixed; only
 * whether a family's providers are *configured* depends on the environment,
 * and that is `family.providers(env)`'s job — every caller passes env there
 * anyway. This used to accept an `env` it immediately discarded (`void env`),
 * which read as an env-scoping of the registry that has never existed.
 */
export function providerFamilies(): readonly ProviderFamily[] {
  return [IMAGES, RESEARCH];
}

export type { KeyedProvider, ProviderFamily, ProviderHealth } from './provider.js';
