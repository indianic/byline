#!/usr/bin/env node

// Node-version guard, FIRST thing — before any `await import` of dist/, whose
// modules use `node:`-scheme imports that old Nodes reject with a cryptic
// ERR_UNSUPPORTED_ESM_URL_SCHEME crash at parse time. package.json's "engines"
// is advisory only (npm warns, it does not enforce at runtime), so a user with
// an old `node` on their PATH would otherwise hit that stack trace on their
// very first `byline init`. This turns it into one clear line. Keep this
// block free of any import / `node:` / top-level await so it runs even on the
// oldest runtimes.
const MIN_NODE_MAJOR = 20;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `byline requires Node >= ${MIN_NODE_MAJOR}, but this command is running on Node ${process.versions.node}.\n` +
      `Your shell's \`node\` is too old — switch to Node ${MIN_NODE_MAJOR}+ (e.g. \`nvm use ${MIN_NODE_MAJOR}\`) and re-run.\n`,
  );
  process.exit(1);
}

// Wrapped in an async function rather than using top-level `await` so the
// version guard above still runs on Nodes old enough to reject top-level await
// at parse time — a clean message on old runtimes is the whole point.
async function main() {
  const args = process.argv.slice(2);

  // No subcommand → normally this is an MCP host launching the stdio server
  // (`claude mcp add byline -- npx -y @indianic/byline`). But a HUMAN
  // typing bare `byline` in a terminal would otherwise get a silently
  // hanging JSON-RPC server waiting on stdin. MCP hosts always launch over
  // pipes, never a TTY — so stdin+stdout both being TTYs reliably means
  // "person at a prompt": show the CLI help instead.
  if (args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.stderr.write(
        'Bare `byline` starts the MCP stdio server — that is what your AI tool launches, not a terminal command.\n' +
          'Showing the CLI instead (try `byline init` to get set up):\n\n',
      );
      const { runCli } = await import('../dist/cli/main.js');
      await runCli(['help']);
    } else {
      // Call main() explicitly rather than relying on dist/index.js's own
      // "run when executed directly" self-check: a dynamic import from here
      // does not change process.argv[1], so that check never fires for this
      // path and the server would silently never start.
      const { main: startMcpServer } = await import('../dist/index.js');
      await startMcpServer();
    }
  } else {
    const { runCli } = await import('../dist/cli/main.js');
    await runCli(args);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
