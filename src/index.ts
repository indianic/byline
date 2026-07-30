#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Context, loadContext } from './context.js';
import { registerAllTools } from './tools/index.js';
import { getPackageVersion } from './version.js';

export function buildServer(ctx: Context): McpServer {
  const server = new McpServer({ name: 'byline', version: getPackageVersion() });
  registerAllTools(server, ctx);
  return server;
}

/**
 * Exported (not just invoked as a side effect of this module loading) because
 * `bin/byline.js` reaches this via a dynamic `await import('../dist/index.js')`.
 * A dynamic import does not change `process.argv[1]` — it stays the bin
 * script's own path — so the old "only run when executed directly" guard
 * (`import.meta.url === file://${process.argv[1]}`) never matched when
 * launched through the shim: the MCP server would silently never start.
 * Calling `main()` explicitly from the caller sidesteps that entirely.
 */
export async function main(): Promise<void> {
  const server = buildServer(loadContext());
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly (e.g. `node dist/index.js`), so tests can
// import buildServer/main without starting a server, and so this file still
// works as a standalone entry point outside the bin shim.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `byline failed to start: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
