import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the owning backend's synthetic generator and actual DTO/store APIs.
// No backend source, database or managed runtime is mutated.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.resolve(process.argv[2] || path.join(root, '../autopilot'));
const target = path.join(root, 'tests/fixtures/pipeline-viewer-contract');
const scratch = path.join(root, 'tmp/docs/handoffs/pipeline-viewer/generate-contract-fixtures.ts');
const ignored = spawnSync('git', ['check-ignore', scratch], { cwd: root });
if (ignored.status !== 0) throw new Error('Fixture scratch script must be Git-ignored.');
let source = readFileSync(path.join(backend, 'scripts/pipeline-viewer-fixtures.ts'), 'utf8');
source = source.replace('save("measurements.json", metrics);', '');
source = source.replaceAll('"../src/', `"${backend}/src/`);
source = source.replace('const target = new URL("../docs/fixtures/pipeline-viewer/", import.meta.url).pathname;', `const target = ${JSON.stringify(target)};`);
const capture = source.match(/const retrieveStep =[^\n]+\nconst arrayRef =[^\n]+\n/);
if (!capture || !source.includes('const snapshot = viewerSnapshot(run.id, store, serviceId);')) {
  throw new Error('Backend fixture generator changed; review its capture/snapshot seam.');
}
// The extra array record must exist before the summary snapshot advertises it.
source = source.replace(capture[0], '').replace('const snapshot = viewerSnapshot(run.id, store, serviceId);', `${capture[0]}const snapshot = viewerSnapshot(run.id, store, serviceId);`);
mkdirSync(path.dirname(scratch), { recursive: true });
writeFileSync(scratch, source);
const result = spawnSync('bun', [scratch], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Backend contract fixture generation failed: ${result.status}`);
