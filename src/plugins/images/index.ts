import { ToolError } from '../../errors.js';
import { GeminiImages } from './gemini/index.js';
import { GrokImages } from './grok/index.js';
import type { Aspect, ImageProvider, ProviderHealth } from './types.js';

/** Why one provider in the chain did not produce an image. */
export interface ProviderFailure {
  provider: string;
  /** The provider's own `ToolError.code`, `NOT_CONFIGURED`, or `UNEXPECTED`. */
  code: string;
  message: string;
}

/**
 * Every provider failed, with each provider's reason kept separate.
 *
 * The separation is the point. `generate_image` has to distinguish "every
 * provider REFUSED this prompt" — a safety block, where retrying without
 * people is the right move — from "something BROKE" — a 401, an exhausted
 * quota, a dead socket — where retrying de-peopled would silently drop the
 * people requirement because the network blipped.
 *
 * Before this, that decision could only be made by substring-matching the
 * joined English message, which is exactly the class of mistake this codebase
 * has shipped nine times. Codes make it decidable.
 *
 * A **subclass** rather than a widened `ToolError`: `toJSON()` is inherited
 * untouched, so the wire envelope every MCP client already handles is
 * byte-identical, and `failures` stays an in-process detail for the one caller
 * that needs it.
 */
export class AllProvidersFailed extends ToolError {
  readonly failures: readonly ProviderFailure[];

  constructor(failures: ProviderFailure[], reasons: string[] = failures.map((f) => `${f.provider}: ${f.message}`)) {
    super({
      api: 'images',
      code: 'ALL_PROVIDERS_FAILED',
      message: `Every image provider failed — ${reasons.join('; ')}`,
      hint: 'Run health_check, or reword the prompt if a provider reported SAFETY',
    });
    this.name = 'AllProvidersFailed';
    this.failures = failures;
  }
}

/**
 * Every image provider, in fallback order.
 *
 * Takes `env` explicitly (defaulting to `process.env`) rather than letting each
 * provider read `process.env` itself, so a caller resolving against a non-ambient
 * environment — `buildSetupState` under a custom `env`, as in tests, or an
 * embedder that doesn't run under a plain process env — gets a chain that
 * actually reflects THAT environment, not whatever happens to be in `process.env`.
 *
 * The env var name for each provider is read from that provider's OWN
 * `credential.name` rather than hardcoded here a second time. Both used to name
 * `GEMINI_API_KEY` / `XAI_API_KEY` independently — two sources for one fact,
 * free to drift, which defeated the whole point of `credential` existing.
 * Constructing a throwaway instance first is cheap (no I/O in either
 * constructor) and is the only way to read a provider's declared name before
 * deciding which env var to pass it for real.
 */
export function defaultChain(env: NodeJS.ProcessEnv = process.env): ImageProvider[] {
  const gemini = new GeminiImages('');
  const grok = new GrokImages('');
  return [new GeminiImages(env[gemini.credential.name] ?? ''), new GrokImages(env[grok.credential.name] ?? '')];
}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  provider: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface GenerateOptions {
  aspect?: Aspect;
  /** Pin one provider. Disables fallback. */
  provider?: string;
  chain?: ImageProvider[];
}

export async function generateImage(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<GeneratedImage> {
  const chain = opts.chain ?? defaultChain();
  const aspect = opts.aspect ?? '16:9';

  if (opts.provider) {
    const pinned = chain.find((p) => p.name === opts.provider);
    if (!pinned) {
      throw new ToolError({
        api: 'images',
        code: 'UNKNOWN_PROVIDER',
        message: `No image provider "${opts.provider}". Available: ${chain
          .map((p) => p.name)
          .join(', ')}`,
      });
    }
    const out = await pinned.generate(prompt, aspect);
    return { ...out, provider: pinned.name, fallbackUsed: false };
  }

  const reasons: string[] = [];
  const failures: ProviderFailure[] = [];
  for (const p of chain) {
    if (!p.configured()) {
      reasons.push(`${p.name}: not configured`);
      failures.push({ provider: p.name, code: 'NOT_CONFIGURED', message: 'not configured' });
      continue;
    }
    try {
      const out = await p.generate(prompt, aspect);
      return {
        ...out,
        provider: p.name,
        fallbackUsed: reasons.length > 0,
        ...(reasons.length > 0 ? { fallbackReason: reasons.join('; ') } : {}),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reasons.push(`${p.name}: ${message}`);
      failures.push({
        provider: p.name,
        code: e instanceof ToolError ? e.code : 'UNEXPECTED',
        message,
      });
    }
  }

  throw new AllProvidersFailed(failures, reasons);
}

export async function imageHealth(chain = defaultChain()): Promise<ProviderHealth[]> {
  return Promise.all(chain.map((p) => p.healthCheck()));
}

export type { ImageProvider, ProviderHealth, Aspect } from './types.js';
