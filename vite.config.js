import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

import { createVersionMetadata, readReleaseNotesManifest } from './scripts/release-notes.mjs';

const DIST_DIR = path.resolve(__dirname, 'dist');
const SUITE_ROOT = path.resolve(__dirname, '..');
const SUITE_INTEGRATION_TESTS = [
  './tests/contract-signer-roles.test.js',
  './tests/schema-sync.test.js',
  './tests/wp7-terminology-consistency.test.js',
];
const HAS_SUITE_FIXTURES = [
  path.join(SUITE_ROOT, 'docs', 'contract', 'group-signer-share-contract.md'),
  path.join(SUITE_ROOT, 'sb-publisher', 'schemas', 'flightdeck'),
  path.join(SUITE_ROOT, 'wingman-tower', 'src', 'types.ts'),
].every((fixturePath) => fs.existsSync(fixturePath));

function trimText(value) {
  return String(value ?? '').trim();
}

function isNpub(value) {
  return /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(trimText(value));
}

function requireNpubEnv(loadedEnv, name) {
  const value = trimText(loadedEnv[name]);
  if (!isNpub(value)) {
    throw new Error(`${name} must be set to the Flight Deck app npub`);
  }
  return value;
}

function flightDeckIdentityPlugin() {
  return {
    name: 'flightdeck-identity',
    config(_config, env) {
      const loadedEnv = loadEnv(env.mode, process.cwd(), '');
      const pgAppNpub = requireNpubEnv(loadedEnv, 'FLIGHT_DECK_PG_APP_NPUB');
      return {
        define: {
          __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(pgAppNpub),
          __FLIGHTDECK_PIPELINE_VIEWER_ENABLED__: loadedEnv.FLIGHTDECK_PIPELINE_VIEWER_ENABLED === '1',
        },
      };
    },
  };
}

function readBuildMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { absoluteVersion: 0, lastBuildDate: '', dailyVersion: 0 };
  }
}

export function buildServiceWorkerSource(buildId) {
  return `
const BUILD_ID = ${JSON.stringify(buildId)};
const CACHE_PREFIX = 'wingman-fd';
const CACHE_NAME = \`\${CACHE_PREFIX}-\${BUILD_ID}\`;
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/wingman-logo-192x192.png',
  '/wingman-logo-512x512.png',
  '/wingman-logo.png',
  '/version.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function parsePushPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    try {
      return { body: event.data?.text?.() || '' };
    } catch {
      return {};
    }
  }
}

function pushTargetUrl(payload = {}) {
  const target = payload.target && typeof payload.target === 'object' ? payload.target : payload;
  const directUrl = String(
    payload.url || payload.click_url || payload.clickUrl || target.url || target.click_url || target.clickUrl || ''
  ).trim();
  if (directUrl) return new URL(directUrl, self.location.origin).toString();

  const workspaceSlug = String(payload.workspace_slug || target.workspace_slug || target.workspaceSlug || '').trim();
  const workspaceKey = String(payload.workspace_key || target.workspace_key || target.workspaceKey || '').trim();
  const workspaceId = String(payload.workspace_id || payload.workspaceId || target.workspace_id || target.workspaceId || '').trim();
  const route = String(payload.route || target.route || '').trim().toLowerCase();
  const category = String(payload.category || target.category || '').trim().toLowerCase();
  const section = String(target.section || target.surface || target.type || payload.section || payload.surface || payload.type || category).trim().toLowerCase();
  const hasTaskTarget = Boolean(target.task_id || target.taskId);
  const hasDocumentTarget = Boolean(target.doc_id || target.document_id || target.docId || target.documentId);
  const hasChatTarget = Boolean(target.channel_id || target.channelId || target.thread_id || target.threadId || target.message_id || target.messageId);
  const routeSection = section === 'dm' || section === 'thread' || section === 'message' || section === 'chat'
    || section === 'chat_thread' || section === 'mention'
    || route.includes('/channels/')
    || (hasChatTarget && !hasTaskTarget && !hasDocumentTarget)
    ? 'chat'
    : section === 'task' || section === 'task_assignment' || section === 'task_comment' || route.includes('/tasks/') || (section === 'comment' && hasTaskTarget)
      ? 'tasks'
      : section === 'document' || section === 'doc' || section === 'doc_comment' || section === 'document_comment' || route.includes('/docs/') || (section === 'comment' && hasDocumentTarget)
        ? 'docs'
        : 'flight-deck';
  const path = workspaceSlug ? \`/\${encodeURIComponent(workspaceSlug)}/\${routeSection}\` : \`/\${routeSection}\`;
  const url = new URL(path, self.location.origin);
  if (workspaceKey) url.searchParams.set('workspacekey', workspaceKey);
  if (workspaceId) url.searchParams.set('workspaceid', workspaceId);
  const scopeId = String(target.scope_id || target.scopeId || '').trim();
  if (scopeId) url.searchParams.set('scopeid', scopeId);
  const channelId = String(target.channel_id || target.channelId || '').trim();
  const threadId = String(target.thread_id || target.threadId || target.message_id || target.messageId || '').trim();
  const docId = String(target.doc_id || target.document_id || target.docId || target.documentId || '').trim();
  const commentId = String(target.comment_id || target.commentId || '').trim();
  const taskId = String(target.task_id || target.taskId || '').trim();
  if (routeSection === 'chat') {
    if (channelId) url.searchParams.set('channelid', channelId);
    if (threadId) url.searchParams.set('threadid', threadId);
  } else if (routeSection === 'docs') {
    if (docId) url.searchParams.set('docid', docId);
    if (commentId) url.searchParams.set('commentid', commentId);
  } else if (routeSection === 'tasks') {
    if (taskId) url.searchParams.set('taskid', taskId);
    if (commentId) url.searchParams.set('commentid', commentId);
  }
  return url.toString();
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const title = String(payload.title || 'Flight Deck').trim();
  const body = String(payload.body || payload.message || '').trim();
  const notificationOptions = {
    body,
    icon: payload.icon || '/wingman-logo-192x192.png',
    badge: payload.badge || '/wingman-logo-192x192.png',
    tag: payload.tag || payload.dedupe_key || undefined,
    data: {
      url: pushTargetUrl(payload),
      target: payload.target || null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, notificationOptions));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || self.location.origin;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(targetUrl, self.location.origin);
    for (const client of windows) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin !== target.origin) continue;
      client.postMessage?.({ type: ${JSON.stringify('flightdeck:notification-click')}, url: target.toString() });
      const navigated = await client.navigate?.(target.toString()).catch(() => null);
      await (navigated || client).focus?.();
      return;
    }
    await self.clients.openWindow(target.toString());
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const appShell = await cache.match('/index.html');
    if (appShell) return appShell;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => undefined);
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/version.json') {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith('/assets/') || PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
`;
}

export function missingDistAssetGuardPlugin() {
  return {
    name: 'missing-dist-asset-guard',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next();
          return;
        }

        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const relativeAssetPath = pathname.slice('/assets/'.length);
        const existingPath = path.join(DIST_DIR, 'assets', relativeAssetPath);
        if (!pathname.startsWith('/assets/') || fs.existsSync(existingPath)) {
          next();
          return;
        }

        response.statusCode = 404;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(request.method === 'HEAD' ? undefined : 'Asset not found');
      });
    },
  };
}

export function buildVersionPlugin() {
  let buildId = null;
  let buildNumber = null;
  let builtAt = null;
  let releaseNotesManifest = null;

  return {
    name: 'build-version',
    config(_config, env) {
      const metaPath = path.resolve(__dirname, '.build-meta.json');
      const meta = readBuildMeta(metaPath);

      const now = new Date();
      const date = now.toISOString().slice(0, 10).replace(/-/g, '');
      const time = now.toISOString().slice(11, 16).replace(':', '');
      const todayKey = now.toISOString().slice(0, 10);
      builtAt = now.toISOString();

      if (env.command === 'build') {
        const deterministic = readDeterministicBuildVersion(process.env);
        const daily = todayKey === meta.lastBuildDate ? (meta.dailyVersion || 0) + 1 : 1;
        const absolute = (meta.absoluteVersion || 0) + 1;
        buildNumber = deterministic?.buildNumber ?? absolute;
        buildId = deterministic?.buildId ?? `${date}-${time}-${daily}-${absolute}`;
        builtAt = deterministic?.builtAt ?? builtAt;

        releaseNotesManifest = readReleaseNotesManifest(path.resolve(__dirname, 'release-notes.json'));
        createVersionMetadata({ buildId, buildNumber, builtAt, manifest: releaseNotesManifest });

        if (!deterministic) {
          fs.writeFileSync(metaPath, JSON.stringify({
            absoluteVersion: absolute,
            lastBuildDate: todayKey,
            dailyVersion: daily,
          }, null, 2) + '\n');
        }
      } else {
        const absolute = Number(meta.absoluteVersion || 0);
        buildNumber = Math.max(absolute, 0);
        buildId = `${date}-dev-${String(Math.max(absolute, 0)).padStart(4, '0')}`;
      }

      const define = {
        __APP_BUILD_ID__: JSON.stringify(buildId),
        __APP_BUILD_NUMBER__: JSON.stringify(buildNumber),
      };

      return { define };
    },
    generateBundle() {
      if (!buildId || !buildNumber || !builtAt || !releaseNotesManifest) return;
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(createVersionMetadata({
          buildId,
          buildNumber,
          builtAt,
          manifest: releaseNotesManifest,
        })),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source: buildServiceWorkerSource(buildId),
      });
    },
    transformIndexHtml() {
      if (!buildId) return [];
      return [{
        tag: 'meta',
        attrs: { name: 'flightdeck-build-id', content: buildId },
        injectTo: 'head-prepend',
      }];
    },
  };
}

export function readDeterministicBuildVersion(environment = process.env) {
  const rawNumber = environment.FLIGHTDECK_BUILD_NUMBER?.trim() ?? '';
  const buildId = environment.FLIGHTDECK_BUILD_ID?.trim() ?? '';
  const rawEpoch = environment.SOURCE_DATE_EPOCH?.trim() ?? '';
  const supplied = [rawNumber, buildId, rawEpoch].filter(Boolean).length;
  if (supplied === 0) return null;
  if (supplied !== 3) {
    throw new Error(
      'FLIGHTDECK_BUILD_NUMBER, FLIGHTDECK_BUILD_ID, and SOURCE_DATE_EPOCH must be supplied together.',
    );
  }
  if (!/^\d+$/.test(rawNumber) || !/^\d+$/.test(rawEpoch)) {
    throw new Error('Deterministic build number and source epoch must be positive integers.');
  }
  const buildNumber = Number(rawNumber);
  const epochSeconds = Number(rawEpoch);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error('FLIGHTDECK_BUILD_NUMBER must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1) {
    throw new Error('SOURCE_DATE_EPOCH must be a positive safe integer.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(buildId)) {
    throw new Error('FLIGHTDECK_BUILD_ID contains unsupported characters.');
  }
  return {
    buildNumber,
    buildId,
    builtAt: new Date(epochSeconds * 1000).toISOString(),
  };
}

export default defineConfig({
  // Keep dynamic materializers in the worker entry: a split child can import
  // that entry again in WebKit, duplicating the DB singleton and listeners.
  worker: { format: 'es', rollupOptions: { output: { inlineDynamicImports: true } } },
  root: '.',
  plugins: [flightDeckIdentityPlugin(), buildVersionPlugin(), missingDistAssetGuardPlugin()],
  server: {
    host: true,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3100',
        changeOrigin: true,
        secure: false,
        xfwd: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
  },
  appType: 'spa',
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['./tests/**/*.test.js'],
    exclude: [
      './tests/e2e/**',
      './tests/bun/**',
      ...(!HAS_SUITE_FIXTURES ? SUITE_INTEGRATION_TESTS : []),
    ],
  },
});
