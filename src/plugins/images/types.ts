import type { CredentialField } from '../platforms/types.js';

export type Aspect = '16:9' | '4:3' | '1:1';

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  status?: number;
  detail: string;
}

export interface ImageProvider {
  readonly name: string;
  /**
   * The environment variable this provider's key lives in, described the same
   * way a platform describes its credentials.
   *
   * Reuses `CredentialField` deliberately: the installer walks platform
   * credentials and provider keys with one function, and neither list is
   * allowed to be hardcoded in `src/cli/`. `name` here is the ENV VAR name
   * (there is no config.yaml block for a provider — the key goes straight to
   * `.env`), which is why it reads `GEMINI_API_KEY` rather than `api_key`.
   */
  readonly credential: CredentialField;
  /** False when the provider's API key is absent, so the chain can skip it cleanly. */
  configured(): boolean;
  /**
   * The same provider bound to a different key.
   *
   * The installer validates a key the user has just typed by probing it,
   * which needs an instance carrying that candidate key without disturbing
   * the configured chain still in use around it.
   *
   * This used to be `provider.constructor as new (apiKey: string) =>
   * ImageProvider` in `src/cli/credentials.ts`. An `as` cast typechecks
   * unconditionally, so it asserted a constructor shape nothing declared:
   * correct for both providers that existed, and a third whose constructor
   * took anything else would have broken at RUNTIME, inside `init`, while the
   * user was mid-prompt. Declaring it here makes the compiler enforce what
   * the cast merely assumed — the same discipline `credential` was added for.
   *
   * Must return a NEW instance and mutate nothing.
   */
  withKey(key: string): ImageProvider;
  healthCheck(): Promise<ProviderHealth>;
  generate(prompt: string, aspect: Aspect): Promise<{ data: Buffer; mime: string }>;
}
