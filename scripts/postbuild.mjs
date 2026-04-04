/**
 * Postbuild script: prepend shebangs to CLI/MCP entry points.
 * tsc strips shebangs from source files, so we re-add them after compilation.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHEBANG = '#!/usr/bin/env node\n';

for (const file of ['dist/cli.js', 'dist/user-mcp.js']) {
  const filePath = resolve(__dirname, '..', file);
  const content = readFileSync(filePath, 'utf8');
  if (!content.startsWith('#!')) {
    writeFileSync(filePath, SHEBANG + content);
  }
}
