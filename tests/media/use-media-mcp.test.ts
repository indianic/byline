import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadPersonas } from '../../src/config/personas.js';
import { loadSites, usableSites } from '../../src/config/sites.js';
import type { Context } from '../../src/context.js';
import { buildServer } from '../../src/index.js';
import { loadMedia } from '../../src/media/library.js';
import { FAKE_ADMIN_KEY } from '../fixtures/keys.js';

/**
 * `use_media` THROUGH THE MCP TOOL LAYER.
 *
 * Everything else about this tool is tested by calling `useMedia` directly,
 * which cannot see the failure this file exists for: the MCP SDK's zod parsing
 * SILENTLY STRIPS keys the input schema does not declare. That is how
 * `feature_image_id` was added to the adapter, tested, and did nothing — the
 * value never survived the trip from tool call to handler, and every direct
 * unit test passed because it passed the field in itself.
 *
 * `allow_reuse` is the same shape of input: a flag the handler reads, whose
 * only observable effect is that an upload happens which otherwise would not.
 * So it is asserted here, where the argument really does go through the tool
 * layer's parsing.
 */

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const uploadImage = vi.fn(async (_f: Buffer, name: string) => ({
  url: `https://blog.example.com/content/${name}`,
  id: '42',
}));

vi.mock('../../src/tools/shared.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/shared.js')>()),
  adapterFor: () => ({ uploadImage }),
}));

const SITES = `
default_site: personal
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PERSONAL_GHOST_KEY}
`;

/** A real Context, built field by field the way tests/tools.test.ts does. */
function makeContext(): Context {
  const dir = mkdtempSync(join(tmpdir(), 'wb-media-mcp-'));
  const root = join(dir, 'shots');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.png'), PNG_1x1);

  const sitesFile = join(dir, 'sites.yaml');
  writeFileSync(sitesFile, SITES);
  const mediaFile = join(dir, 'media.yaml');
  writeFileSync(mediaFile, `media:\n  libraries:\n    - name: shots\n      path: ${root}\n`);

  const personasDir = mkdtempSync(join(tmpdir(), 'wb-media-mcp-p-'));
  const env = { PERSONAL_GHOST_KEY: FAKE_ADMIN_KEY };
  const sites = loadSites(sitesFile, env);
  const personas = loadPersonas(personasDir);
  const runsDir = mkdtempSync(join(tmpdir(), 'wb-media-mcp-runs-'));
  const paths = {
    home: dir,
    source: 'env' as const,
    configFile: sitesFile,
    personasDir,
    envFile: join(dir, '.env'),
    runsDir,
  };

  return {
    paths,
    sitesFile,
    personasDir,
    sites,
    personas,
    media: loadMedia(mediaFile, env),
    runsDir,
    env,
    setup: {
      configured: usableSites(sites).length > 0,
      paths,
      siteCount: Object.keys(sites.sites).length,
      usableSiteCount: usableSites(sites).length,
      personaCount: personas.size,
      imageProviders: [],
      problems: [],
      siteProblems: [],
    },
  };
}

async function callTool(ctx: Context, name: string, args: Record<string, unknown>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([c.connect(ct), buildServer(ctx).connect(st)]);
  const res = await c.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text: string }>)[0]!;
  await c.close();
  return JSON.parse(first.text);
}

describe('use_media through the MCP tool layer', () => {
  it('refuses a used asset, and allow_reuse actually reaches the handler', async () => {
    const ctx = makeContext();
    await callTool(ctx, 'list_media_libraries', { scan: true });

    const first = await callTool(ctx, 'use_media', {
      site: 'personal',
      assets: [{ path: 'a.png' }],
    });
    expect(first.ok).toBe(true);
    expect(first.uploaded).toBe(1);

    const refused = await callTool(ctx, 'use_media', {
      site: 'personal',
      assets: [{ path: 'a.png' }],
    });
    expect(refused.uploaded).toBe(0);
    expect(refused.images[0].code).toBe('ALREADY_USED');

    // If zod stripped `allow_reuse`, this call is identical to the one above
    // and comes back ALREADY_USED — which is exactly how the stripped
    // `feature_image_id` looked: correct code, no effect.
    const forced = await callTool(ctx, 'use_media', {
      site: 'personal',
      assets: [{ path: 'a.png' }],
      allow_reuse: true,
    });
    expect(forced.uploaded).toBe(1);
    expect(forced.images[0].ok).toBe(true);
  });

  it('refuses a video with a ToolError envelope naming media', async () => {
    const ctx = makeContext();
    writeFileSync(join(ctx.paths.home, 'shots', 'clip.mp4'), Buffer.from([0, 0, 0, 0x18]));
    await callTool(ctx, 'list_media_libraries', { scan: true });

    const out = await callTool(ctx, 'use_media', {
      site: 'personal',
      assets: [{ path: 'clip.mp4' }],
    });
    expect(out.ok).toBe(false);
    expect(out.api).toBe('media');
    expect(out.code).toBe('VIDEO_NOT_SUPPORTED');
    expect(out.hint).toBeTruthy();
    expect(out.message).toMatch(/video/i);
  });
});
