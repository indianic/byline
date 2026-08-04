import { ToolError } from '../../../errors.js';
import type { Aspect, ImageProvider, ProviderHealth } from '../types.js';

/**
 * The image model, verified against the live API on 2026-08-03.
 *
 * `grok-2-image-1212` was here until then, and xAI had **deprecated it on
 * 2026-02-24**. Every fallback generation had been failing for months with
 * "no longer accessible via the API" — and nothing surfaced it, because the
 * fallback only runs when Gemini fails and `healthCheck` was reporting the
 * provider as fine (see below). Confirmed live: `GET /v1/image-generation-models`
 * returns exactly `grok-imagine-image` and `grok-imagine-image-quality`, and
 * the old id is absent from the list entirely.
 */
const MODEL = 'grok-imagine-image';

/**
 * The endpoint that lists IMAGE models specifically.
 *
 * `healthCheck` used to probe `/v1/models`, which answers 200 for any valid
 * key regardless of which models exist — so it reported "grok-2-image-1212
 * reachable" for a model that had not existed since February. That is the same
 * defect as Ghost's `healthCheck` probing an endpoint that needs no auth:
 * checking something adjacent to the thing you actually depend on, and
 * reporting the result as if it were proof.
 */
const MODELS_ENDPOINT = 'https://api.x.ai/v1/image-generation-models';
const ENDPOINT = 'https://api.x.ai/v1/images/generations';

interface GrokResponse {
  data?: Array<{ b64_json?: string }>;
  error?: string | { message?: string };
}

export class GrokImages implements ImageProvider {
  readonly name = 'grok';
  readonly credential = {
    name: 'XAI_API_KEY',
    label: 'xAI (Grok) API key',
    secret: true,
    example: 'xai-…',
    help: 'console.x.ai → API Keys → Create API key. Optional — this is the fallback used only when Gemini fails.',
  } as const;
  constructor(private readonly apiKey = process.env.XAI_API_KEY ?? '') {}

  configured(): boolean {
    return this.apiKey.length > 0;
  }

  withKey(key: string): ImageProvider {
    return new GrokImages(key);
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.configured()) {
      return { provider: this.name, ok: false, detail: 'XAI_API_KEY is not set' };
    }
    try {
      const res = await fetch(MODELS_ENDPOINT, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        return { provider: this.name, ok: false, status: res.status, detail: await res.text() };
      }
      // A 200 proves the key works. It does not prove THIS model is one the
      // account can still call, which is the only thing `generate` needs.
      const body = (await res.json()) as { models?: Array<{ id?: string }>; data?: Array<{ id?: string }> };
      const ids = (body.models ?? body.data ?? []).map((m) => m.id).filter(Boolean);
      return ids.includes(MODEL)
        ? { provider: this.name, ok: true, status: res.status, detail: `${MODEL} available` }
        : {
            provider: this.name,
            ok: false,
            status: res.status,
            detail: `${MODEL} is not in this account's image models (${ids.join(', ') || 'none listed'}). It may have been deprecated — check console.x.ai.`,
          };
    } catch (e) {
      return {
        provider: this.name,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** xAI's image model has no aspect-ratio parameter; the ratio is steered by the prompt. */
  async generate(prompt: string, aspect: Aspect): Promise<{ data: Buffer; mime: string }> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: `${prompt}\n\nComposition: ${aspect} aspect ratio.`,
        n: 1,
        response_format: 'b64_json',
      }),
    });

    const body = (await res.json()) as GrokResponse;

    if (!res.ok) {
      const msg = typeof body.error === 'string' ? body.error : body.error?.message;
      throw new ToolError({
        api: 'grok',
        status: res.status,
        code: 'GROK_ERROR',
        message: msg ?? `xAI returned ${res.status}`,
      });
    }

    const b64 = body.data?.[0]?.b64_json;
    if (!b64) {
      throw new ToolError({
        api: 'grok',
        status: res.status,
        code: 'NO_IMAGE',
        message: 'xAI returned no image data',
      });
    }
    return { data: Buffer.from(b64, 'base64'), mime: 'image/png' };
  }
}
