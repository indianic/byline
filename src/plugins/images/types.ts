import type { KeyedProvider } from '../provider.js';

export type Aspect = '16:9' | '4:3' | '1:1';

export type { ProviderHealth } from '../provider.js';

export interface ImageProvider extends KeyedProvider {
  /** Narrows `KeyedProvider.withKey`'s return so the image chain stays typed. */
  withKey(key: string): ImageProvider;
  generate(prompt: string, aspect: Aspect): Promise<{ data: Buffer; mime: string }>;
}
