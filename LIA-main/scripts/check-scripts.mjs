import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function collectScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectScripts(fullPath));
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await collectScripts(fileURLToPath(new URL('.', import.meta.url)));
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exit(1);
console.log(`Script syntax OK (${files.length} files)`);
