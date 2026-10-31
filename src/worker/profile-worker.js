import { fetchRelayProfile } from '../profile-relay-fetch.js';

self.addEventListener('message', async ({ data }) => {
  try {
    const profile = await fetchRelayProfile(data.npub, data.options);
    self.postMessage({ id: data.id, profile });
  } catch {
    self.postMessage({ id: data.id, profile: null });
  }
});
