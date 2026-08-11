// src/tools/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '../context.js';
import { registerCraftTools } from './craft-tools.js';
import { registerImageTools } from './image-tools.js';
import { registerMediaTools } from './media-tools.js';
import { registerPersonaTools } from './persona-tools.js';
import { registerPostTools } from './post-tools.js';
import { registerResearchTools } from './research-tools.js';
import { registerSiteTools } from './site-tools.js';

/**
 * Registration order determines the order tools appear to the host model.
 * Diagnostics first, then discovery, then the writing pipeline in the sequence
 * a post actually moves through it.
 */
export function registerAllTools(server: McpServer, ctx: Context): void {
  registerSiteTools(server, ctx);
  registerPersonaTools(server, ctx);
  registerResearchTools(server, ctx); // research precedes the brief it feeds
  registerMediaTools(server, ctx); // discovery, like research: precedes the brief
  registerCraftTools(server, ctx);
  registerImageTools(server, ctx);
  registerPostTools(server, ctx);
}
