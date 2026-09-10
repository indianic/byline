// src/plugins/platforms/substack/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import { ExportAdapter } from '../export/adapter.js';
import type { ExportSpec } from '../export/types.js';
import type { PlatformPlugin } from '../types.js';
import { SUBSTACK_HTML_PROFILE } from './html-profile.js';

const PASTE_STEPS = [
  'Open your Substack dashboard and click New post.',
  'Click Copy article on this page, click into the post editor, paste.',
  'Type the title and subtitle into their own fields.',
  'Drag each image from the images folder onto its [Insert image: …] line and delete the marker.',
  "Set the cover image and SEO settings under the post's settings panel (the gear icon).",
  "Add the tags from this page if you use them, then Publish or schedule from Substack's own editor.",
] as const;

export const SUBSTACK_SPEC: ExportSpec = {
  platformId: 'substack',
  label: 'Substack',
  pasteSteps: PASTE_STEPS,
  profile: SUBSTACK_HTML_PROFILE,
};

export const substackPlugin: PlatformPlugin = {
  id: 'substack',
  label: 'Substack',

  credentialSchema: z.object({
    platform: z.literal('substack'),
    url: z.string().url(),
    export_dir: z.string().min(1),
    default_author: z.string().optional(),
  }),

  credentialFields: [
    {
      name: 'export_dir',
      label: 'Folder for exported posts',
      secret: false,
      example: '~/Documents/byline-post',
      help: "Substack has no publishing API, so Byline writes each article into a folder here — text, images and a page with copy buttons — and you paste it into Substack's editor. Any folder you can write to.",
    },
  ],

  defaultApiUrl: (siteUrl) => siteUrl,

  makeAdapter: (site: SiteConfig) => new ExportAdapter(site, SUBSTACK_SPEC),

  isAuthorId: () => false,

  htmlProfile: async () => SUBSTACK_HTML_PROFILE,
};
