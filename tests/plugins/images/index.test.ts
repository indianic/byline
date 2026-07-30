import { describe, expect, it } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import { AllProvidersFailed, defaultChain, generateImage } from '../../../src/plugins/images/index.js';
import type { ImageProvider } from '../../../src/plugins/images/types.js';

function provider(name: string, behaviour: 'ok' | 'throw' | 'unconfigured'): ImageProvider {
  return {
    name,
    credential: { name: `${name.toUpperCase()}_API_KEY`, label: `${name} key`, secret: true, example: 'x', help: 'h' },
    configured: () => behaviour !== 'unconfigured',
    withKey: () => provider(name, behaviour),
    healthCheck: async () => ({ provider: name, ok: true, detail: 'stub' }),
    generate: async () => {
      if (behaviour === 'throw') {
        throw new ToolError({ api: name, code: 'SAFETY', message: `${name} refused: SAFETY` });
      }
      return { data: Buffer.from(name), mime: 'image/png' };
    },
  };
}

describe('generateImage', () => {
  it('uses the first provider and reports no fallback', async () => {
    const r = await generateImage('a cat', {
      chain: [provider('gemini', 'ok'), provider('grok', 'ok')],
    });
    expect(r.provider).toBe('gemini');
    expect(r.fallbackUsed).toBe(false);
    expect(r.data.toString()).toBe('gemini');
  });

  it('falls back and reports why the default declined', async () => {
    const r = await generateImage('a cat', {
      chain: [provider('gemini', 'throw'), provider('grok', 'ok')],
    });
    expect(r.provider).toBe('grok');
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackReason).toContain('gemini refused: SAFETY');
  });

  it('skips unconfigured providers without counting them as failures', async () => {
    const r = await generateImage('a cat', {
      chain: [provider('gemini', 'unconfigured'), provider('grok', 'ok')],
    });
    expect(r.provider).toBe('grok');
    expect(r.fallbackReason).toContain('not configured');
  });

  it('does not fall back when a provider is pinned', async () => {
    await expect(
      generateImage('a cat', {
        provider: 'gemini',
        chain: [provider('gemini', 'throw'), provider('grok', 'ok')],
      }),
    ).rejects.toThrowError(/gemini refused/);
  });

  it('errors when the pinned provider is not in the chain', async () => {
    try {
      await generateImage('a cat', { provider: 'dalle', chain: [provider('gemini', 'ok')] });
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('UNKNOWN_PROVIDER');
      expect(err.message).toContain('gemini');
    }
  });

  it('collects every failure when the chain is exhausted', async () => {
    try {
      await generateImage('a cat', {
        chain: [provider('gemini', 'throw'), provider('grok', 'throw')],
      });
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('ALL_PROVIDERS_FAILED');
      expect(err.message).toContain('gemini');
      expect(err.message).toContain('grok');
    }
  });

  it('never returns a placeholder image', async () => {
    await expect(
      generateImage('a cat', { chain: [provider('gemini', 'unconfigured')] }),
    ).rejects.toThrowError(ToolError);
  });
});

describe('ImageProvider credential descriptors', () => {
  it('every provider declares the environment variable holding its key', () => {
    const chain = defaultChain({});
    expect(chain.map((p) => p.credential.name)).toEqual(['GEMINI_API_KEY', 'XAI_API_KEY']);
  });

  it('every provider credential is a secret with a label, an example, and a click-path', () => {
    for (const p of defaultChain({})) {
      expect(p.credential.secret).toBe(true);
      expect(p.credential.label.length).toBeGreaterThan(0);
      expect(p.credential.example.length).toBeGreaterThan(0);
      // `help` is what the installer prints so a user can actually find the key.
      expect(p.credential.help.length).toBeGreaterThan(20);
    }
  });
});

// `withKey` replaced `provider.constructor as new (apiKey: string) =>
// ImageProvider` in the installer's liveProviderProbe. That cast typechecked
// unconditionally, so it asserted a constructor shape nothing declared — a
// third provider with a different constructor would have thrown at runtime,
// inside init, mid-prompt.
describe('ImageProvider.withKey', () => {
  it('binds the candidate key without mutating the instance the chain is using', () => {
    // The installer probes a key the user just typed WHILE the configured
    // chain is still live around it. Mutating in place would rebind the
    // running server's provider to a key that may turn out to be wrong.
    const chain = defaultChain({});
    for (const original of chain) {
      expect(original.configured()).toBe(false); // defaultChain({}) sees no keys

      const bound = original.withKey('candidate-key');

      expect(bound).not.toBe(original);
      expect(bound.name).toBe(original.name);
      expect(bound.credential.name).toBe(original.credential.name);
      expect(bound.configured()).toBe(true);
      expect(original.configured()).toBe(false);
    }
  });

  it('is implemented by every provider in the default chain', () => {
    // The point of putting it on the interface: a new provider cannot be
    // added without one. This asserts it at runtime too, since `tsc` does not
    // see a provider that casts its way past the interface.
    for (const p of defaultChain({})) {
      expect(typeof p.withKey).toBe('function');
      expect(p.withKey('k').name).toBe(p.name);
    }
  });
});

/** A provider that fails with a specific ToolError code, for the gate below. */
function failing(name: string, code: string, message = `${name} failed: ${code}`): ImageProvider {
  return {
    name,
    credential: { name: `${name.toUpperCase()}_API_KEY`, label: `${name} key`, secret: true, example: 'x', help: 'h' },
    configured: () => true,
    withKey: () => failing(name, code, message),
    healthCheck: async () => ({ provider: name, ok: false, detail: message }),
    generate: async () => {
      throw new ToolError({ api: name, code, message });
    },
  };
}

/**
 * Why this exists: `generate_image` has to decide whether every provider
 * REFUSED (a safety block, where retrying without people is the right move) or
 * whether something BROKE (a 401, a dead socket — where retrying de-peopled
 * would silently drop people because the network blipped).
 *
 * That decision was only expressible by substring-matching the joined English
 * message, which is precisely the failure mode this codebase has shipped nine
 * times. Per-provider codes make it decidable.
 */
describe('AllProvidersFailed', () => {
  it('reports each provider failure with its own code, not one joined string', async () => {
    const chain = [failing('gemini', 'SAFETY'), failing('grok', 'SAFETY')];
    const err = await generateImage('x', { chain }).catch((e) => e as AllProvidersFailed);

    expect(err).toBeInstanceOf(AllProvidersFailed);
    expect(err.failures.map((f) => f.code)).toEqual(['SAFETY', 'SAFETY']);
    expect(err.failures.map((f) => f.provider)).toEqual(['gemini', 'grok']);
  });

  it('marks an unconfigured provider NOT_CONFIGURED, distinct from a refusal', async () => {
    // A missing key is not a refusal. Conflating them would make "everything
    // refused" true on a machine that simply has one provider unconfigured.
    const chain = [provider('gemini', 'unconfigured'), failing('grok', 'SAFETY')];
    const err = await generateImage('x', { chain }).catch((e) => e as AllProvidersFailed);

    expect(err.failures.map((f) => f.code)).toEqual(['NOT_CONFIGURED', 'SAFETY']);
  });

  it('keeps a transport failure distinguishable from a refusal', async () => {
    const chain = [failing('gemini', 'HTTP_401'), failing('grok', 'SAFETY')];
    const err = await generateImage('x', { chain }).catch((e) => e as AllProvidersFailed);

    expect(err.failures.map((f) => f.code)).toEqual(['HTTP_401', 'SAFETY']);
  });

  it('labels a non-ToolError throw rather than dropping it', async () => {
    const exploding: ImageProvider = {
      ...failing('gemini', 'x'),
      generate: async () => {
        throw new Error('socket hang up');
      },
    };
    const err = await generateImage('x', { chain: [exploding] }).catch((e) => e as AllProvidersFailed);

    expect(err.failures[0]!.code).toBe('UNEXPECTED');
    expect(err.failures[0]!.message).toContain('socket hang up');
  });

  it('keeps the error envelope byte-identical to a plain ToolError', () => {
    // `failures` is for the caller in-process. Widening the wire envelope would
    // change what every MCP client sees for an error it already handles.
    const err = new AllProvidersFailed([{ provider: 'gemini', code: 'SAFETY', message: 'declined' }]);
    expect(err.toJSON()).not.toHaveProperty('failures');
    expect(err.code).toBe('ALL_PROVIDERS_FAILED');
  });

  it('still reads as a ToolError to everything that already catches one', () => {
    const err = new AllProvidersFailed([{ provider: 'gemini', code: 'SAFETY', message: 'declined' }]);
    expect(err).toBeInstanceOf(ToolError);
  });
});
