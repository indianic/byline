// src/tools/shared.ts
import { getSite } from '../config/sites.js';
import type { Context } from '../context.js';
import { fail } from '../errors.js';
import { makeAdapter } from '../plugins/registry.js';
import type { PlatformAdapter } from '../plugins/platforms/types.js';

export const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Every handler funnels through this so no tool ever throws at the protocol layer. */
export function handler<A>(api: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return json(fail(e, api));
    }
  };
}

export function adapterFor(ctx: Pick<Context, 'sites'>, slug: string): PlatformAdapter {
  return makeAdapter(getSite(ctx.sites, slug));
}
