// src/plugins/platforms/ghost/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import type { PlatformPlugin } from '../types.js';
import { GhostAdapter } from './index.js';
import { GHOST_HTML_PROFILE } from './html-profile.js';

/** Ghost object ids are 24 lowercase hex chars — distinguishes an id from a persona slug. */
const GHOST_AUTHOR_ID = /^[0-9a-f]{24}$/i;

export const ghostPlugin: PlatformPlugin = {
  id: 'ghost',
  label: 'Ghost',

  credentialSchema: z.object({
    platform: z.literal('ghost'),
    url: z.string().url(),
    /**
     * Optional admin API base override. Many installs serve the admin API on a
     * different host or path than the public site — two of three real sites did.
     * That mismatch is the usual cause of a 404 on /site/ when the key is fine.
     */
    api_url: z.string().url().optional(),
    /** `id:secret`, both hex, from Ghost Admin > Integrations. Use ${ENV_VAR}. */
    admin_api_key: z.string().min(1),
    default_author: z.string().optional(),
  }),

  credentialFields: [
    {
      name: 'admin_api_key',
      label: 'Admin API key',
      secret: true,
      example: 'id:secret',
      help: 'Ghost Admin → Settings → Integrations → Add custom integration. Copy the ADMIN API key, not the Content API key — they are not interchangeable.',
    },
  ],

  defaultApiUrl: (siteUrl) => `${siteUrl.replace(/\/+$/, '')}/ghost/api/admin`,

  makeAdapter: (site: SiteConfig) => new GhostAdapter(site),

  isAuthorId: (value) => GHOST_AUTHOR_ID.test(value),

  // Ghost's ingest behaviour does not vary by user or install, so the adapter is
  // unused here. WordPress's will not have that luxury.
  htmlProfile: async () => GHOST_HTML_PROFILE,
};
