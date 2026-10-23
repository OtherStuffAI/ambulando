// Isolated database benchmark: one source module instance, no Alpine/runtime boot.
export { liveQuery } from 'dexie';
export { openWorkspaceDb, getWorkspaceDb, getMessagePresentationWindowByChannel,
  getMessagePresentationWindowByChannels } from '../../../src/db.js';
export { buildThreadAwarePresentationWindow } from '../../../src/chat-presentation-cache.js';
export { instrumentIndexedDb } from '../../helpers/indexeddb-metrics.js';
export { scopeChatFixture } from '../../helpers/scope-chat-fixture.js';
