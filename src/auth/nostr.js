import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import * as nip46 from 'nostr-tools/nip46';
import {
  storeCredentials,
  getStoredCredentials,
  clearCredentials,
  refreshCredentialExpiry,
} from './secure-store.js';

export const LOGIN_KIND = 27235;
export const APP_TAG = 'coworker-v4';

export const STORAGE_KEYS = {
  AUTO_LOGIN_METHOD: 'nostr_auto_login_method',
  AUTO_LOGIN_PUBKEY: 'nostr_auto_login_pubkey',
};

let memorySecret = null;
let memoryPubkey = null;
let memoryBunkerSigner = null;
let memoryBunkerUri = null;
let extensionSignerBridge = null;
const DEFAULT_EXTENSION_SIGN_TIMEOUT_MS = 10_000;

function extensionSignerReady() {
  return typeof window !== 'undefined'
    ? Boolean(window.nostr?.getPublicKey && window.nostr?.signEvent)
      || Boolean(extensionSignerBridge?.getPublicKey && extensionSignerBridge?.signEvent)
    : Boolean(extensionSignerBridge?.getPublicKey && extensionSignerBridge?.signEvent);
}

function extensionNip44Ready() {
  return typeof window !== 'undefined'
    ? Boolean(window.nostr?.nip44?.encrypt && window.nostr?.nip44?.decrypt)
      || Boolean(extensionSignerBridge?.encrypt && extensionSignerBridge?.decrypt)
    : Boolean(extensionSignerBridge?.encrypt && extensionSignerBridge?.decrypt);
}

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array();
  return Uint8Array.from(hex.match(/.{1,2}/g) || [], byte => parseInt(byte, 16));
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeNsec(input) {
  try {
    const decoded = nip19.decode(input);
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
      throw new Error('Invalid nsec key.');
    }
    return decoded.data;
  } catch {
    throw new Error('Invalid nsec key.');
  }
}

export function decodeNpub(input) {
  try {
    const decoded = nip19.decode(input);
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
      throw new Error('Invalid npub key.');
    }
    return decoded.data;
  } catch {
    throw new Error('Invalid npub key.');
  }
}

function normalizeSecret(secret) {
  if (secret instanceof Uint8Array) return secret;
  if (typeof secret === 'string') return hexToBytes(secret);
  throw new Error('Secret key is required for local NIP-44 operations.');
}

function localConversationKey(secret, npub) {
  return nip44.getConversationKey(normalizeSecret(secret), decodeNpub(npub));
}

export function buildUnsignedEvent(method) {
  return {
    kind: LOGIN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['app', APP_TAG],
      ['method', method],
    ],
    content: 'Authenticate with Coworker',
  };
}

function buildHttpAuthEvent(url, method, payloadHash) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (payloadHash) tags.push(['payload', payloadHash]);

  return {
    kind: LOGIN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

const SIGN_PRIORITY_HIGH = 'high';
const SIGN_PRIORITY_NORMAL = 'normal';

function createSignScheduler() {
  const queues = {
    [SIGN_PRIORITY_HIGH]: [],
    [SIGN_PRIORITY_NORMAL]: [],
  };
  let active = false;

  const drain = () => {
    if (active) return;
    const job = queues[SIGN_PRIORITY_HIGH].shift() || queues[SIGN_PRIORITY_NORMAL].shift();
    if (!job) return;

    active = true;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        active = false;
        drain();
      });
  };

  return (run, priority = SIGN_PRIORITY_NORMAL) => new Promise((resolve, reject) => {
    const queue = priority === SIGN_PRIORITY_HIGH
      ? queues[SIGN_PRIORITY_HIGH]
      : queues[SIGN_PRIORITY_NORMAL];
    queue.push({ run, resolve, reject });
    drain();
  });
}

const scheduleNip07Sign = createSignScheduler();
const scheduleExtensionBridgeSign = createSignScheduler();

function normalizeSignTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXTENSION_SIGN_TIMEOUT_MS;
}

function signerTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'sign_timeout';
      reject(error);
    }, normalizeSignTimeoutMs(timeoutMs));
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

function serialNip07SignEvent(event, options = {}) {
  const run = () => signerTimeout(
    window.nostr.signEvent({
      ...event,
      created_at: Math.floor(Date.now() / 1000),
    }),
    options.timeoutMs,
    options.timeoutMessage || 'NIP-07 signing timed out.',
  );
  return scheduleNip07Sign(run, options.priority);
}

function serialBridgeSignEvent(event, options = {}) {
  const run = () => signerTimeout(
    extensionSignerBridge.signEvent({
      ...event,
      created_at: Math.floor(Date.now() / 1000),
    }),
    options.timeoutMs,
    options.timeoutMessage || 'Extension bridge signing timed out.',
  );
  return scheduleExtensionBridgeSign(run, options.priority);
}

async function sha256Hex(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function waitForExtensionSigner(timeoutMs = 2500, intervalMs = 150) {
  if (extensionSignerReady()) return true;
  if (typeof window === 'undefined') return false;

  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (extensionSignerReady()) return true;
  }

  return extensionSignerReady();
}

export function getMemorySecret() {
  return memorySecret;
}

export function setMemorySecret(secret) {
  memorySecret = secret;
}

export function getMemoryPubkey() {
  return memoryPubkey;
}

export function setMemoryPubkey(pubkey) {
  memoryPubkey = pubkey;
}

export function getMemoryBunkerSigner() {
  return memoryBunkerSigner;
}

export function setMemoryBunkerSigner(signer) {
  memoryBunkerSigner = signer;
}

export function getMemoryBunkerUri() {
  return memoryBunkerUri;
}

export function setMemoryBunkerUri(uri) {
  memoryBunkerUri = uri;
}

export function clearMemoryCredentials() {
  memorySecret = null;
  memoryPubkey = null;
  memoryBunkerSigner = null;
  memoryBunkerUri = null;
}

export function setExtensionSignerBridge(bridge) {
  if (bridge?.getPublicKey && bridge?.signEvent) {
    extensionSignerBridge = bridge;
    return;
  }
  extensionSignerBridge = null;
}

export function clearExtensionSignerBridge() {
  extensionSignerBridge = null;
}

export function getPubkeyFromEvent(event) {
  return event?.pubkey ?? null;
}

export async function getExtensionPublicKey() {
  if (typeof window !== 'undefined' && window.nostr?.getPublicKey) {
    return window.nostr.getPublicKey();
  }
  if (extensionSignerBridge?.getPublicKey) {
    return extensionSignerBridge.getPublicKey();
  }
  throw new Error('No NIP-07 browser extension found.');
}

export async function signEventWithExtension(event, options = {}) {
  if (typeof window !== 'undefined' && window.nostr?.signEvent) {
    return serialNip07SignEvent(event, options);
  }
  if (extensionSignerBridge?.signEvent) {
    return serialBridgeSignEvent(event, options);
  }
  throw new Error('No NIP-07 browser extension found.');
}

export async function pubkeyToNpub(pubkey) {
  return nip19.npubEncode(pubkey);
}

export function secretToNsec(secret) {
  return nip19.nsecEncode(normalizeSecret(secret));
}

export function secretToPubkey(secret) {
  return getPublicKey(normalizeSecret(secret));
}

export function generateLocalIdentity() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    secret,
    secretHex: bytesToHex(secret),
    nsec: nip19.nsecEncode(secret),
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}

export const createGroupIdentity = generateLocalIdentity;

export async function signLoginEvent(method, supplemental = null) {
  if (method === 'ephemeral') {
    const storedCreds = await getStoredCredentials();
    let secretHex = storedCreds?.method === 'ephemeral' ? storedCreds.secretHex : null;
    if (!secretHex) secretHex = bytesToHex(generateSecretKey());
    const secret = hexToBytes(secretHex);
    setMemorySecret(secret);
    const event = finalizeEvent(buildUnsignedEvent(method), secret);
    await storeCredentials({ method: 'ephemeral', pubkey: event.pubkey, secretHex });
    return event;
  }

  if (method === 'extension') {
    const available = await waitForExtensionSigner();
    if (!available) {
      throw new Error('No NIP-07 browser extension found.');
    }
    const pubkey = await getExtensionPublicKey();
    const event = { ...buildUnsignedEvent(method), pubkey };
    const signedEvent = await signEventWithExtension(event);
    if (signedEvent?.pubkey !== pubkey) {
      throw new Error('NIP-07 signer pubkey changed during login. Sign in again.');
    }
    setMemoryPubkey(pubkey);
    await storeCredentials({ method: 'extension', pubkey, authEvent: signedEvent });
    return signedEvent;
  }

  if (method === 'bunker') {
    let signer = getMemoryBunkerSigner();
    if (!signer) {
      const bunkerUri = supplemental || getMemoryBunkerUri();
      if (!bunkerUri) throw new Error('No bunker connection available.');
      const pointer = await nip46.parseBunkerInput(bunkerUri);
      if (!pointer) throw new Error('Unable to parse bunker details.');

      const clientSecret = generateSecretKey();
      signer = new nip46.BunkerSigner(clientSecret, pointer);
      await signer.connect();
      setMemoryBunkerSigner(signer);
      setMemoryBunkerUri(bunkerUri);
    }

    const signedEvent = await signer.signEvent(buildUnsignedEvent(method));
    await storeCredentials({
      method: 'bunker',
      pubkey: signedEvent.pubkey,
      bunkerUri: supplemental || getMemoryBunkerUri(),
    });
    return signedEvent;
  }

  if (method === 'secret') {
    let secret = getMemorySecret();
    if (!secret && supplemental) {
      secret = decodeNsec(supplemental.trim());
      setMemorySecret(secret);
    }
    if (!secret) throw new Error('No secret key available.');

    const secretHex = bytesToHex(secret);
    const event = finalizeEvent(buildUnsignedEvent(method), secret);
    await storeCredentials({ method: 'secret', pubkey: event.pubkey, secretHex });
    return event;
  }

  throw new Error(`Unsupported login method: ${method}`);
}

export async function createNip98AuthHeader(url, method, body = null, options = {}) {
  const creds = await getStoredCredentials();
  const authMethod = creds?.method;
  if (!authMethod) throw new Error('No Nostr session available for NIP-98 auth.');

  let payloadHash = null;
  if (body !== null && body !== undefined && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    payloadHash = await sha256Hex(serialized);
  }

  const eventTemplate = buildHttpAuthEvent(url, method, payloadHash);
  if (options.freshContent) eventTemplate.content = crypto.randomUUID();

  if (authMethod === 'ephemeral' || authMethod === 'secret') {
    let secret = getMemorySecret();
    if (!secret && creds.secretHex) {
      secret = hexToBytes(creds.secretHex);
      setMemorySecret(secret);
    }
    if (!secret) throw new Error('No secret key available for NIP-98 auth.');
    const signedEvent = finalizeEvent(eventTemplate, secret);
    await refreshCredentialExpiry();
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  if (authMethod === 'extension') {
    const available = await waitForExtensionSigner();
    if (!available) {
      throw new Error('No NIP-07 browser extension found.');
    }
    const currentPubkey = await getExtensionPublicKey();
    const expectedPubkey = getMemoryPubkey() || creds.pubkey || currentPubkey;
    if (currentPubkey !== expectedPubkey) {
      throw new Error('NIP-07 signer pubkey changed since login. Sign in again.');
    }
    const pubkey = currentPubkey;
    const signedEvent = await signEventWithExtension({ ...eventTemplate, pubkey }, {
      timeoutMs: options.signTimeoutMs || options.timeoutMs,
      timeoutMessage: options.timeoutMessage,
      priority: options.priority || (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase())
          ? SIGN_PRIORITY_HIGH
          : SIGN_PRIORITY_NORMAL
      ),
    });
    if (signedEvent?.pubkey !== pubkey) {
      throw new Error('NIP-07 signer returned a different pubkey than the active session. Sign in again.');
    }
    setMemoryPubkey(pubkey);
    await refreshCredentialExpiry();
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  if (authMethod === 'bunker') {
    const signedEvent = await signerTimeout((async () => {
      let signer = getMemoryBunkerSigner();
      if (!signer) {
        const bunkerUri = creds.bunkerUri || getMemoryBunkerUri();
        if (!bunkerUri) throw new Error('No bunker connection available.');
        const pointer = await nip46.parseBunkerInput(bunkerUri);
        if (!pointer) throw new Error('Unable to parse bunker details.');
        const clientSecret = generateSecretKey();
        signer = new nip46.BunkerSigner(clientSecret, pointer);
        await signer.connect();
        setMemoryBunkerSigner(signer);
        setMemoryBunkerUri(bunkerUri);
      }
      return signer.signEvent({
        ...eventTemplate,
        created_at: Math.floor(Date.now() / 1000),
      });
    })(), options.signTimeoutMs || options.timeoutMs, options.timeoutMessage || 'Bunker signing timed out.');
    await refreshCredentialExpiry();
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  throw new Error(`Unsupported NIP-98 auth method: ${authMethod}`);
}

export async function createNip98AuthHeaderForSecret(url, method, body = null, secret) {
  if (!secret) throw new Error('No secret key available for scoped NIP-98 auth.');

  let payloadHash = null;
  if (body !== null && body !== undefined && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    payloadHash = await sha256Hex(serialized);
  }

  const eventTemplate = buildHttpAuthEvent(url, method, payloadHash);
  const signedEvent = finalizeEvent(eventTemplate, normalizeSecret(secret));
  return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
}

export async function signNostrEvent(eventTemplate) {
  const creds = await getStoredCredentials();
  const authMethod = creds?.method;
  if (!authMethod) throw new Error('No Nostr session available for event signing.');

  if (authMethod === 'ephemeral' || authMethod === 'secret') {
    let secret = getMemorySecret();
    if (!secret && creds.secretHex) {
      secret = hexToBytes(creds.secretHex);
      setMemorySecret(secret);
    }
    if (!secret) throw new Error('No secret key available for event signing.');
    const signedEvent = finalizeEvent(eventTemplate, secret);
    await refreshCredentialExpiry();
    return signedEvent;
  }

  if (authMethod === 'extension') {
    const available = await waitForExtensionSigner();
    if (!available) throw new Error('No NIP-07 browser extension found.');
    const currentPubkey = await getExtensionPublicKey();
    const expectedPubkey = getMemoryPubkey() || creds.pubkey || currentPubkey;
    if (currentPubkey !== expectedPubkey) {
      throw new Error('NIP-07 signer pubkey changed since login. Sign in again.');
    }
    const signedEvent = await signEventWithExtension(
      { ...eventTemplate, pubkey: currentPubkey },
      { priority: SIGN_PRIORITY_HIGH },
    );
    if (signedEvent?.pubkey !== currentPubkey) {
      throw new Error('NIP-07 signer returned a different pubkey than the active session. Sign in again.');
    }
    setMemoryPubkey(currentPubkey);
    await refreshCredentialExpiry();
    return signedEvent;
  }

  if (authMethod === 'bunker') {
    const signer = await withBunkerSigner();
    const signedEvent = await signer.signEvent(eventTemplate);
    await refreshCredentialExpiry();
    return signedEvent;
  }

  throw new Error(`Unsupported event signing method: ${authMethod}`);
}

async function withBunkerSigner() {
  let signer = getMemoryBunkerSigner();
  if (signer) return signer;

  const creds = await getStoredCredentials();
  const bunkerUri = creds?.bunkerUri || getMemoryBunkerUri();
  if (!bunkerUri) throw new Error('No bunker connection available.');
  const pointer = await nip46.parseBunkerInput(bunkerUri);
  if (!pointer) throw new Error('Unable to parse bunker details.');

  const clientSecret = generateSecretKey();
  signer = new nip46.BunkerSigner(clientSecret, pointer);
  await signer.connect();
  setMemoryBunkerSigner(signer);
  setMemoryBunkerUri(bunkerUri);
  return signer;
}

async function withAuthSecret() {
  const creds = await getStoredCredentials();
  const authMethod = creds?.method;

  if (authMethod === 'extension') {
    const available = await waitForExtensionSigner();
    if (!available) throw new Error('No NIP-07 browser extension found.');
    if (!extensionNip44Ready()) throw new Error('NIP-07 signer does not expose NIP-44 encryption.');
    const pubkeyHex = getMemoryPubkey() || creds.pubkey || await getExtensionPublicKey();
    if (typeof window !== 'undefined' && window.nostr?.nip44?.encrypt && window.nostr?.nip44?.decrypt) {
      return {
        method: 'extension',
        pubkeyHex,
        encrypt: async (peerPubkeyHex, plaintext) => window.nostr.nip44.encrypt(peerPubkeyHex, plaintext),
        decrypt: async (peerPubkeyHex, ciphertext) => window.nostr.nip44.decrypt(peerPubkeyHex, ciphertext),
      };
    }
    if (extensionSignerBridge?.encrypt && extensionSignerBridge?.decrypt) {
      return {
        method: 'extension',
        pubkeyHex,
        encrypt: async (peerPubkeyHex, plaintext) => extensionSignerBridge.encrypt(peerPubkeyHex, plaintext),
        decrypt: async (peerPubkeyHex, ciphertext) => extensionSignerBridge.decrypt(peerPubkeyHex, ciphertext),
      };
    }
    return {
      method: 'extension',
      pubkeyHex,
      encrypt: async (peerPubkeyHex, plaintext) => window.nostr.nip44.encrypt(peerPubkeyHex, plaintext),
      decrypt: async (peerPubkeyHex, ciphertext) => window.nostr.nip44.decrypt(peerPubkeyHex, ciphertext),
    };
  }

  if (authMethod === 'ephemeral' || authMethod === 'secret') {
    let secret = getMemorySecret();
    if (!secret && creds?.secretHex) {
      secret = hexToBytes(creds.secretHex);
      setMemorySecret(secret);
    }
    if (!secret) throw new Error('No secret key available for NIP-44 encryption.');

    return {
      method: authMethod,
      pubkeyHex: getPublicKey(secret),
      encrypt: async (pubkeyHex, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secret, pubkeyHex)),
      decrypt: async (pubkeyHex, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(secret, pubkeyHex)),
    };
  }

  if (authMethod === 'bunker') {
    const signer = await withBunkerSigner();
    if (signer?.nip44?.encrypt && signer?.nip44?.decrypt) {
      return {
        method: 'bunker',
        pubkeyHex: getMemoryPubkey() || creds?.pubkey || null,
        encrypt: async (pubkeyHex, plaintext) => signer.nip44.encrypt(pubkeyHex, plaintext),
        decrypt: async (pubkeyHex, ciphertext) => signer.nip44.decrypt(pubkeyHex, ciphertext),
      };
    }
    if (typeof signer?.nip44Encrypt === 'function' && typeof signer?.nip44Decrypt === 'function') {
      return {
        method: 'bunker',
        pubkeyHex: getMemoryPubkey() || creds?.pubkey || null,
        encrypt: async (pubkeyHex, plaintext) => signer.nip44Encrypt(pubkeyHex, plaintext),
        decrypt: async (pubkeyHex, ciphertext) => signer.nip44Decrypt(pubkeyHex, ciphertext),
      };
    }
    throw new Error('Bunker signer does not expose NIP-44 encryption.');
  }

  throw new Error('No Nostr session available for NIP-44 encryption.');
}

export async function personalEncryptForNpub(npub, plaintext) {
  const signer = await withAuthSecret();
  return signer.encrypt(decodeNpub(npub), plaintext);
}

export async function personalDecryptFromNpub(npub, ciphertext) {
  const signer = await withAuthSecret();
  return signer.decrypt(decodeNpub(npub), ciphertext);
}

export function localEncryptForNpub(secret, npub, plaintext) {
  return nip44.encrypt(plaintext, localConversationKey(secret, npub));
}

export function localDecryptFromNpub(secret, npub, ciphertext) {
  return nip44.decrypt(ciphertext, localConversationKey(secret, npub));
}

export async function tryAutoLoginFromStorage() {
  const creds = await getStoredCredentials();
  if (!creds?.pubkey) return null;

  if (creds.method === 'ephemeral' || creds.method === 'secret') {
    if (!creds.secretHex) return null;
    setMemorySecret(hexToBytes(creds.secretHex));
    setMemoryPubkey(creds.pubkey);
    await refreshCredentialExpiry();
    return { method: creds.method, pubkey: creds.pubkey };
  }

  if (creds.method === 'extension') {
    // Mobile extension browsers can inject NIP-07 well after the app shell has
    // loaded (especially when a push notification wakes the PWA). Restore the
    // persisted session immediately; signing still verifies the live extension
    // pubkey before every authenticated request.
    setMemoryPubkey(creds.pubkey);
    await refreshCredentialExpiry();
    return { method: 'extension', pubkey: creds.pubkey };
  }

  if (creds.method === 'bunker') {
    if (!creds.bunkerUri) return null;
    setMemoryBunkerUri(creds.bunkerUri);
    setMemoryPubkey(creds.pubkey);
    await refreshCredentialExpiry();
    return {
      method: 'bunker',
      pubkey: creds.pubkey,
      bunkerUri: creds.bunkerUri,
      needsReconnect: true,
    };
  }

  return null;
}

export async function clearAutoLogin() {
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_METHOD);
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY);
  clearMemoryCredentials();
  await clearCredentials();
}

export function setAutoLogin(method, pubkey) {
  localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN_METHOD, method);
  localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY, pubkey);
}

export function getAutoLoginMethod() {
  return localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN_METHOD);
}

export function hasExtensionSigner() {
  return extensionSignerReady();
}
