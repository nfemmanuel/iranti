#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distCli = path.join(root, 'dist', 'scripts', 'iranti-cli.js');
const srcCli = path.join(root, 'scripts', 'iranti-cli.ts');

if (fs.existsSync(distCli)) {
  require(distCli);
  return;
}

try {
  require('ts-node/register/transpile-only');
  require(srcCli);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Iranti CLI is not built. Run "npm run build" first.');
  console.error(message);
  process.exit(1);
}
