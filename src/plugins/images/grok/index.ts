import { ToolError } from '../../../errors.js';
import type { Aspect, ImageProvider, ProviderHealth } from '../types.js';

const MODEL = 'grok-2-image-1212';
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
      const res = await fetch('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok
        ? { provider: this.name, ok: true, status: res.status, detail: `${MODEL} reachable` }
        : { provider: this.name, ok: false, status: res.status, detail: await res.text() };
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
