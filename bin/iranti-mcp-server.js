#!/usr/bin/env node
'use strict';

/**
 * Direct MCP stdio server entrypoint.
 *
 * This binary starts the Iranti MCP server immediately, without any CLI routing.
 * It is the preferred entrypoint for MCP clients and tooling (e.g. mcp-proxy)
 * that invoke the server without a subcommand argument.
 *
 * Equivalent to: iranti mcp
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distMcp = path.join(root, 'dist', 'scripts', 'iranti-mcp.js');
const srcMcp = path.join(root, 'scripts', 'iranti-mcp.ts');

if (fs.existsSync(distMcp)) {
  require(distMcp);
  return;
}

try {
  require('ts-node/register/transpile-only');
  require(srcMcp);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write('Iranti MCP server is not built. Run "npm run build" first.\n');
  process.stderr.write(message + '\n');
  process.exit(1);
}
