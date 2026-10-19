import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNStackProviderAdapter } from '../src/nstack-provider.js';
import { nstackRecoveryD, NSTACK_RECOVERY_TYPES } from '../src/nstack-recovery.js';
import { DeterministicNStackProviderFixture } from '../tests/fixtures/nstack-provider-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(process.env.NBROWSER_REPO || path.join(here, '../../../nbrowser'));
const [contract, bridge, access, models, fixturePage] = await Promise.all([
  readFile(path.join(repository, 'docs/nstack-browser-contract.md'), 'utf8'),
  readFile(path.join(repository, 'app/lib/src/features/nstack/nstack_bridge_script.dart'), 'utf8'),
  readFile(path.join(repository, 'app/lib/src/features/nstack/nstack_access.dart'), 'utf8'),
  readFile(path.join(repository, 'app/lib/src/features/nstack/nstack_models.dart'), 'utf8'),
  readFile(path.join(repository, 'app/web/nstack-test.html'), 'utf8'),
]);

for (const method of ['isAvailable', 'requestDiscovery', 'listNStacks', 'listWorkspaces', 'requestCapabilities', 'revoke']) {
  assert.match(contract, new RegExp(`\\b${method}\\b`));
  assert.match(bridge, new RegExp(`\\b${method}\\b`));
  assert.match(fixturePage, new RegExp(`\\b${method}\\b`));
}
for (const code of ['unavailable', 'locked', 'consent_denied', 'not_disclosed', 'invalid_request', 'stale_handle', 'stack_unavailable', 'unsupported_capability']) {
  assert.match(contract, new RegExp(`\\b${code}\\b`));
}
for (const capability of ['workspace.read', 'storage.read', 'storage.write', 'events.read', 'events.write']) {
  assert.match(access, new RegExp(capability.replace('.', '\\.')));
}
assert.match(bridge, /version: 1/);
assert.match(bridge, /detail \|\| \{ reason: 'changed' \}/);
assert.match(models, /org\.wingman\.nbrowser\.settings\.v1/);

const provider = new DeterministicNStackProviderFixture({
  origin: 'https://ambulando.example',
  stacks: [{ id: 'host', name: 'Host', host: true, url: 'https://host.example' }],
  workspaces: { host: [{ id: 'main', name: 'Main' }] },
});
const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
const unsubscribe = adapter.on('change', () => {});
assert.deepEqual(await adapter.isAvailable(), { available: true, version: '1' });
assert.deepEqual(await adapter.requestDiscovery({ workspaces: true }), { disclosed: 1, workspaces: true });
const [stack] = await adapter.listNStacks();
assert.deepEqual(Object.keys(stack).sort(), ['available', 'host', 'id', 'name']);
const [workspace] = await adapter.listWorkspaces({ stackId: stack.id });
assert.deepEqual(Object.keys(workspace).sort(), ['id', 'name']);
const capability = await adapter.requestCapabilities({
  stackId: stack.id,
  workspaceId: workspace.id,
  capabilities: ['workspace.read'],
  duration: 900,
});
assert.equal(capability.connection.url, 'https://host.example');
assert.equal(typeof capability.handle, 'string');
provider.emit('changed');
assert.throws(() => adapter.assertHandleActive(capability.handle), error => error?.code === 'stale_handle');
unsubscribe();

const ambulandoD = await nstackRecoveryD(NSTACK_RECOVERY_TYPES.HOST_HINT);
assert.notEqual(ambulandoD, 'org.wingman.nbrowser.settings.v1');
assert.match(ambulandoD, /^ambulando:nstack:v1:[0-9a-f]{64}$/);

console.log(`window.NStack v1 conformance passed against ${repository}`);
