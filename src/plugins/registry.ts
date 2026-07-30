// src/plugins/registry.ts
import type { SiteConfig } from '../config/sites.js';
import { ToolError } from '../errors.js';
import { ghostPlugin } from './platforms/ghost/plugin.js';
import { wordpressPlugin } from './platforms/wordpress/plugin.js';
import type { PlatformAdapter, PlatformPlugin } from './platforms/types.js';

/**
 * Every supported platform. Adding one means adding its folder and one line here.
 */
export const PLATFORM_PLUGINS: Record<string, PlatformPlugin> = {
  [ghostPlugin.id]: ghostPlugin,
  [wordpressPlugin.id]: wordpressPlugin,
};

export const PLATFORM_IDS = Object.keys(PLATFORM_PLUGINS);

export function getPlugin(id: string): PlatformPlugin {
  const plugin = PLATFORM_PLUGINS[id];
  if (!plugin) {
    throw new ToolError({
      api: 'config',
      code: 'UNKNOWN_PLATFORM',
      message: `Unsupported platform "${id}". Supported: ${PLATFORM_IDS.join(', ')}.`,
    });
  }
  return plugin;
}

export function makeAdapter(site: SiteConfig): PlatformAdapter {
  return getPlugin(site.platform).makeAdapter(site);
}

export type {
  PlatformAdapter,
  PlatformPlugin,
  PostInput,
  PostResult,
  HealthResult,
} from './platforms/types.js';
