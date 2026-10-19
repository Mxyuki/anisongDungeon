/**
 * Syntax-checks every JavaScript module under app/src with `node --check`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listModules(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return listModules(path);
    return name.endsWith('.js') ? [path] : [];
  });
}

let failures = 0;
for (const file of listModules(join(ROOT, 'app', 'src'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures++;
    console.error(`✗ ${relative(ROOT, file)}\n${result.stderr}`);
  }
}

if (failures > 0) {
  console.error(`${failures} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log('All modules passed the syntax check.');
