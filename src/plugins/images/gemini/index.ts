import { ToolError } from '../../../errors.js';
import type { Aspect, ImageProvider, ProviderHealth } from '../types.js';

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

export class GeminiImages implements ImageProvider {
  readonly name = 'gemini';
  readonly credential = {
    name: 'GEMINI_API_KEY',
    label: 'Google Gemini API key',
    secret: true,
    example: 'AIza…',
    help: 'Google AI Studio → Get API key → Create API key. Free tier is enough to start. https://aistudio.google.com/apikey',
  } as const;
  constructor(private readonly apiKey = process.env.GEMINI_API_KEY ?? '') {}

  configured(): boolean {
    return this.apiKey.length > 0;
  }

  withKey(key: string): ImageProvider {
    return new GeminiImages(key);
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.configured()) {
      return { provider: this.name, ok: false, detail: 'GEMINI_API_KEY is not set' };
    }
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        { headers: { 'x-goog-api-key': this.apiKey } },
      );
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

  async generate(prompt: string, aspect: Aspect): Promise<{ data: Buffer; mime: string }> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: aspect } },
      }),
    });

    const body = (await res.json()) as GeminiResponse;

    if (!res.ok) {
      throw new ToolError({
        api: 'gemini',
        status: res.status,
        code: 'GEMINI_ERROR',
        message: body.error?.message ?? `Gemini returned ${res.status}`,
      });
    }

    const blocked = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
    const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);

    if (!part?.inlineData?.data) {
      throw new ToolError({
        api: 'gemini',
        status: res.status,
        code: blocked ? 'SAFETY' : 'NO_IMAGE',
        message: blocked
          ? `Gemini declined the prompt: ${blocked}`
          : 'Gemini returned no image data',
      });
    }

    return {
      data: Buffer.from(part.inlineData.data, 'base64'),
      mime: part.inlineData.mimeType ?? 'image/png',
    };
  }
}
