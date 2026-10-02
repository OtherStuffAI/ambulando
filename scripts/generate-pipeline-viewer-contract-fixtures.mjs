import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Invoke the owning backend's public generator option, never rewrite its source.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.resolve(process.argv[2] || path.join(root, '../autopilot'));
const target = path.join(root, 'tests/fixtures/pipeline-viewer-contract');
const scratch = path.join(root, 'tmp/docs/handoffs/pipeline-viewer/generated-contract');
if (spawnSync('git', ['check-ignore', scratch], { cwd: root }).status !== 0) throw new Error('Fixture output must be Git-ignored.');
mkdirSync(scratch, { recursive: true });
if (!process.argv.includes('--runtime-only')) {
  const result = spawnSync('bun', [path.join(root, 'scripts/pipeline-viewer-contract-fixtures.ts'), backend, scratch], {
    cwd: backend, stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Backend API fixture generation failed: ${result.status}`);
  // Copy only reusable synthetic contracts; operational metrics stay ignored.
  const files = readdirSync(scratch).filter(name => name.endsWith('.json') && name !== 'measurements.json');
  if (!files.includes('completed-run.json')) throw new Error('API fixture generation did not produce a completed snapshot.');
  mkdirSync(target, { recursive: true });
  for (const name of files) copyFileSync(path.join(scratch, name), path.join(target, name));
}
const runtime = path.join(backend, 'docs/fixtures/pipeline-viewer/runtime');
mkdirSync(path.join(target, 'runtime'), { recursive: true });
const directories = [runtime];
if (existsSync(path.join(runtime, 'evidence'))) directories.push(path.join(runtime, 'evidence'));
for (const directory of directories) {
  const relative = path.relative(runtime, directory);
  mkdirSync(path.join(target, 'runtime', relative), { recursive: true });
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const original = readFileSync(path.join(directory, name), 'utf8');
    // Normalize only the hostile synthetic mention's display label, preserving
    // its four-byte width, escaping, IDs, timestamps, capture lengths and structure.
    const publicFixture = name.startsWith('bird-')
      ? original.replaceAll(['R','i','c','k'].join(''), 'Test') : original;
    writeFileSync(path.join(target, 'runtime', relative, name), publicFixture);
  }
}
