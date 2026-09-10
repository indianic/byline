// src/plugins/platforms/medium/plugin.ts
import { z } from 'zod';
import type { SiteConfig } from '../../../config/sites.js';
import { ExportAdapter } from '../export/adapter.js';
import type { ExportSpec } from '../export/types.js';
import type { PlatformPlugin } from '../types.js';
import { MEDIUM_HTML_PROFILE } from './html-profile.js';

/** Numbered, shown verbatim on the hand-off page's "How to publish" section. */
const PASTE_STEPS = [
  'Open medium.com/new-story.',
  'Click Copy article on this page, click into the story, paste.',
  'Type the title and subtitle into their own fields.',
  'Drag each image from the images folder onto its [Insert image: …] line and delete the marker.',
  'Add the tags from this page under Publish → Add a topic.',
  "Set the canonical link under … → Customize → Advanced settings if this was published elsewhere first.",
] as const;

export const MEDIUM_SPEC: ExportSpec = {
  platformId: 'medium',
  label: 'Medium',
  pasteSteps: PASTE_STEPS,
  profile: MEDIUM_HTML_PROFILE,
};

export const mediumPlugin: PlatformPlugin = {
  id: 'medium',
  label: 'Medium',

  credentialSchema: z.object({
    platform: z.literal('medium'),
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
      help: "Medium has no publishing API, so Byline writes each article into a folder here — text, images and a page with copy buttons — and you paste it into Medium's editor. Any folder you can write to.",
    },
  ],

  // Nothing is ever called — kept so SiteConfig.apiUrl is always defined.
  defaultApiUrl: (siteUrl) => siteUrl,

  makeAdapter: (site: SiteConfig) => new ExportAdapter(site, MEDIUM_SPEC),

  isAuthorId: () => false,

  htmlProfile: async () => MEDIUM_HTML_PROFILE,
};
