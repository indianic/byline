import type { CredentialField } from './platforms/types.js';

/** The result of asking a provider whether its key actually works. */
export interface ProviderHealth {
  provider: string;
  ok: boolean;
  status?: number;
  detail: string;
}

/**
 * A provider identified by a single API key, described well enough that the
 * CLI can walk it without knowing what it does.
 *
 * This is the type `src/cli/credentials.ts` consumes. It exists so that
 * `collectProviderKeys` serves image providers and research providers with one
 * function — the same reason `ImageProvider` was widened to carry
 * `CredentialField` in the first place. Neither family's name appears anywhere
 * under `src/cli/`.
 */
export interface KeyedProvider {
  readonly name: string;
  /**
   * `name` here is the ENV VAR (`GEMINI_API_KEY`, not `api_key`) — a provider
   * key goes straight to `.env` and has no config.yaml block.
   */
  readonly credential: CredentialField;
  configured(): boolean;
  /**
   * The same provider bound to a different key. Must return a NEW instance and
   * mutate nothing.
   *
   * Declared rather than reached via `provider.constructor as new (k: string)
   * => T`: that cast typechecked unconditionally and would have thrown at
   * runtime, inside `init`, mid-prompt, for any provider whose constructor took
   * anything else.
   */
  withKey(key: string): KeyedProvider;
  healthCheck(): Promise<ProviderHealth>;
}

/**
 * A group of providers the installer offers together.
 *
 * `init`, `doctor`, and `status` iterate families rather than naming
 * `defaultChain()` directly, so registering a family in `providers.ts` is the
 * ONLY edit a new family needs. `src/cli/` gains no branch.
 */
export interface ProviderFamily {
  readonly id: 'images' | 'research';
  /** Shown as the section heading by `status` and `doctor`. */
  readonly label: string;
  /** The yes/no question `init` asks before walking this family's keys. */
  readonly initPrompt: string;
  /**
   * What `doctor` says about a configured-but-skipped provider in THIS family.
   *
   * Per-family and not shared, because the images copy — "the second provider
   * is a fallback most users skip" — is true for images and FALSE for
   * research: there is no research fallback, and saying so would tell a user
   * their unconfigured provider will be covered by the other one. A shared
   * renderer carrying one family's semantics into another is condition (b) in
   * `docs/ADDING-A-PLATFORM.md`, the same shape as the `<div>` card message
   * that shipped.
   */
  readonly unconfiguredNote: string;
  /**
   * Takes `env` explicitly so a caller resolving against a non-ambient
   * environment (tests, an embedder) gets providers reflecting THAT env.
   */
  providers(env: NodeJS.ProcessEnv): readonly KeyedProvider[];
}
