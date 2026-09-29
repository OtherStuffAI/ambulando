import { Lexer, Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { buildSectionUrl, parseRouteLocation } from './route-helpers.js';
import { normalizeRecordLinkType } from './record-links.js';
import { isFlightDeckSurfaceDisabled } from './disabled-surfaces.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(rawHref, allowedProtocols = []) {
  const href = String(rawHref ?? '').trim();
  if (!href) return null;

  try {
    const url = new URL(href);
    return allowedProtocols.includes(url.protocol) ? url.href : null;
  } catch {
    const lowerHref = href.toLowerCase();
    return allowedProtocols.some((protocol) => lowerHref.startsWith(protocol)) ? href : null;
  }
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWindowHref() {
  if (typeof window !== 'undefined' && window.location?.href) return window.location.href;
  return 'http://localhost/';
}

function getWindowOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost';
}

function normalizeFlightDeckRoute(url) {
  const route = parseRouteLocation(url.href);
  const currentRoute = parseRouteLocation(getWindowHref());
  const params = route.params || {};
  const currentParams = currentRoute.params || {};
  let section = route.section;
  const workspaceSlug = route.workspaceSlug || currentRoute.workspaceSlug || null;
  const workspacekey = params.workspacekey || currentParams.workspacekey || null;
  const needsWorkspaceSlug = !route.workspaceSlug && Boolean(workspaceSlug) && route.section !== 'status';

  if (params.docid && section !== 'docs') section = 'docs';
  else if (params.reportid && section !== 'reports' && !isFlightDeckSurfaceDisabled('reports')) section = 'reports';
  else if ((params.taskid || params.view) && section !== 'tasks') section = 'tasks';
  else if ((params.channelid || params.threadid) && section !== 'chat') section = 'chat';
  else if (!needsWorkspaceSlug && (!workspacekey || params.workspacekey === workspacekey)) return url.href;

  const nextUrl = new URL(buildSectionUrl({
    workspaceSlug,
    section,
    scopeid: params.scopeid,
    params: {
      channelid: params.channelid,
      threadid: params.threadid,
      folderid: params.folderid,
      docid: params.docid,
      versioning: params.versioning,
      commentid: params.commentid,
      descendants: params.descendants,
      groupid: params.groupid,
      reportid: params.reportid,
      taskid: params.taskid,
      view: params.view,
      workspacekey,
      token: params.token,
    },
  }), url.origin);
  nextUrl.hash = url.hash;
  return nextUrl.href;
}

export function resolveMarkdownHref(rawHref) {
  const href = String(rawHref ?? '').trim();
  if (!href) return null;

  const explicitHref = sanitizeUrl(href, ['file:', 'http:', 'https:', 'mailto:', 'nostr:']);
  if (explicitHref) {
    try {
      const resolved = new URL(explicitHref);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.origin === getWindowOrigin() ? normalizeFlightDeckRoute(resolved) : resolved.href;
      }
      return resolved.href;
    } catch {
      return explicitHref;
    }
  }

  try {
    const resolved = new URL(href, getWindowHref());
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (resolved.origin !== getWindowOrigin()) return null;
    return normalizeFlightDeckRoute(resolved);
  } catch {
    return null;
  }
}

function buildStorageImageMarkup(altText, objectId) {
  const safeAlt = escapeHtml(altText);
  const safeObjectId = escapeHtml(objectId);
  return `<span class="md-storage-image-wrap"><img class="md-storage-image md-storage-image-pending" data-storage-object-id="${safeObjectId}" alt="${safeAlt}" loading="lazy" /><span class="md-storage-image-label">${safeAlt}</span></span>`;
}

function buildRemoteImageMarkup(altText, href, title) {
  const safeAlt = escapeHtml(altText);
  const safeHref = escapeHtml(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="md-storage-image-wrap"><img class="md-storage-image" src="${safeHref}" alt="${safeAlt}" loading="lazy"${titleAttr} /><span class="md-storage-image-label">${safeAlt}</span></span>`;
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function buildStorageFileCardMarkup(labelHtml, objectId, title) {
  const displayName = stripHtml(labelHtml) || objectId || 'Uploaded file';
  const safeObjectId = escapeHtml(objectId);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return [
    `<a href="#" class="md-storage-file-card" data-storage-object-id="${safeObjectId}" data-storage-file-name="${escapeHtml(displayName)}"${titleAttr}>`,
    '<span class="md-storage-file-icon" aria-hidden="true">',
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path></svg>',
    '</span>',
    '<span class="md-storage-file-copy">',
    `<strong>${labelHtml || escapeHtml(displayName)}</strong>`,
    `<small>Uploaded file${objectId ? ` - ${safeObjectId}` : ''}</small>`,
    '</span>',
    '</a>',
  ].join('');
}

function fileNameFromHref(href) {
  try {
    const url = new URL(href);
    const [fileName = ''] = decodeURIComponent(url.pathname || '').split('/').filter(Boolean).slice(-1);
    return fileName || url.hostname || href;
  } catch {
    const clean = String(href || '').replace(/[?#].*$/, '');
    return clean.split('/').filter(Boolean).slice(-1)[0] || href;
  }
}

function isImageHref(href) {
  const clean = String(href || '').split(/[?#]/)[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(clean);
}

function buildReferenceFileCardMarkup(labelHtml, href, title) {
  const displayName = stripHtml(labelHtml) || fileNameFromHref(href) || 'Referenced file';
  const safeHref = escapeHtml(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return [
    `<a href="${safeHref}" class="md-storage-file-card md-reference-file-card" target="_blank" rel="noopener noreferrer" data-reference-file-url="${safeHref}"${titleAttr}>`,
    '<span class="md-storage-file-icon" aria-hidden="true">',
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path></svg>',
    '</span>',
    '<span class="md-storage-file-copy">',
    `<strong>${labelHtml || escapeHtml(displayName)}</strong>`,
    '<small>Referenced file</small>',
    '</span>',
    '</a>',
  ].join('');
}

function buildMentionPillMarkup(labelHtml, mentionType, mentionId) {
  const displayName = stripHtml(labelHtml) || 'Mention';
  const safeType = escapeHtml(mentionType);
  const safeId = escapeHtml(mentionId);
  const actorPrefix = mentionType === 'person' || mentionType === 'agent' ? '@' : '';
  const icon = {
    file: '<svg class="mention-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 1.75h5l4 4v8.5h-9z"></path><path d="M8.5 1.75v4h4"></path></svg>',
    doc: '<svg class="mention-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.75h10v12.5H3z"></path><path d="M5.5 5h5M5.5 7.75h5M5.5 10.5h3.25"></path></svg>',
    tag: '<svg class="mention-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.75 2H3v5.75l5.75 5.75 4.75-4.75z"></path><circle cx="5.25" cy="4.25" r=".75" fill="currentColor" stroke="none"></circle></svg>',
  }[mentionType] || '';
  const currentRoute = mentionType === 'task' ? parseRouteLocation(getWindowHref()) : null;
  const href = currentRoute
    ? buildSectionUrl({
      workspaceSlug: currentRoute.workspaceSlug,
      section: 'tasks',
      scopeid: currentRoute.params?.scopeid,
      params: {
        taskid: mentionId,
        workspacekey: currentRoute.params?.workspacekey,
      },
    })
    : '#';
  return `<a href="${escapeHtml(href)}" class="mention-link mention-pill mention-link-${safeType} mention-pill-${safeType}" data-mention-render="pill" data-mention-type="${safeType}" data-mention-id="${safeId}" aria-label="${safeType} ${escapeHtml(displayName)}">${icon}${actorPrefix}${labelHtml || escapeHtml(displayName)}</a>`;
}

export function renderDeckCardTextToHtml(source) {
  const text = String(source ?? '');
  const mentionPattern = /@?\[([^\]\n]+)\]\(mention:([a-z]+):([^\s)]+)\)/gi;
  let html = '';
  let offset = 0;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const mentionType = normalizeRecordLinkType(match[2] || '');
    const mentionId = String(match[3] || '').trim();
    if (!mentionType || !mentionId) continue;
    html += escapeHtml(text.slice(offset, match.index));
    html += buildMentionPillMarkup(escapeHtml(match[1]), mentionType, mentionId);
    offset = match.index + match[0].length;
  }

  return html + escapeHtml(text.slice(offset));
}

function escapeMarkdownLabel(value) {
  return String(value ?? '').replace(/([\\\[\]])/g, '\\$1');
}

export function expandInlineReferenceLinks(source, references = []) {
  let output = String(source ?? '');
  const normalizedReferences = (Array.isArray(references) ? references : [])
    .map((ref) => ({
      type: normalizeRecordLinkType(ref?.type || 'doc') || 'doc',
      id: String(ref?.id || ref?.record_id || '').trim(),
      label: String(ref?.label || ref?.title || '').trim(),
    }))
    .filter((ref) => ref.id && ref.label)
    .sort((left, right) => right.label.length - left.label.length);

  for (const ref of normalizedReferences) {
    const pattern = new RegExp(`(^|[^\\w@])@@${escapeRegExp(ref.label)}(?=$|[\\s.,;:!?)}\\]])`, 'g');
    output = output.replace(pattern, (_, prefix) => {
      const label = escapeMarkdownLabel(ref.label);
      if (ref.type === 'doc') {
        return `${prefix}[${label}](mention:${ref.type}:${ref.id} "reference-card")`;
      }
      return `${prefix}@[${label}](mention:${ref.type}:${ref.id})`;
    });
  }

  return output;
}

export function normalizeEscapedFileReferences(source) {
  const cleanLabel = (label) => String(label || '').replace(/\\+$/g, '').replace(/\\([\[\]])/g, '$1');
  return String(source ?? '')
    .replace(/\\*!\\*\[([^\]]+)\]\\*\((file:\/\/[^)\s\\]+)\\*\)/g, (_, label, href) => `![${cleanLabel(label)}](${href})`)
    .replace(/\\+\[([^\]]+)\]\\*\((file:\/\/[^)\s\\]+)\\*\)/g, (_, label, href) => `[${cleanLabel(label)}](${href})`);
}

export function normalizeDocumentMentionCardLinks(source) {
  return String(source ?? '')
    .replace(/@\[([^\]]+)\]\(mention:([a-z]+):([^)]+)\)/gi, (_, label, type, id) => `[${label}](mention:${type}:${id})`);
}

const markdown = new Marked({
  async: false,
  breaks: true,
  gfm: true,
});

const renderer = new markdown.Renderer();

const CODE_LANGUAGE_ALIASES = Object.freeze({
  bash: 'bash',
  cjs: 'javascript',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
});

function normalizeCodeLanguage(rawLanguage) {
  return String(rawLanguage || '').trim().split(/\s+/)[0].toLowerCase();
}

function highlightCode(code, language) {
  const highlightLanguage = CODE_LANGUAGE_ALIASES[language] || language;
  if (!highlightLanguage || !hljs.getLanguage(highlightLanguage)) return escapeHtml(code);
  return hljs.highlight(code, { language: highlightLanguage, ignoreIllegals: true }).value;
}

function buildCodeBlockMarkup(code, rawLanguage) {
  const language = normalizeCodeLanguage(rawLanguage);
  const languageLabel = language || 'plain text';
  const languageClass = language ? ` language-${escapeHtml(language)}` : '';
  return [
    `<div class="md-code-block" data-code-language="${escapeHtml(language || 'plain')}">`,
    '<div class="md-code-block-toolbar">',
    `<span class="md-code-block-language">${escapeHtml(languageLabel)}</span>`,
    '<button type="button" class="md-code-copy-button" data-md-code-copy aria-label="Copy code to clipboard">',
    '<svg class="md-code-copy-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5"></rect><path d="M10.75 5.25V3.5A1.5 1.5 0 0 0 9.25 2h-5.5A1.75 1.75 0 0 0 2 3.75v5.5a1.5 1.5 0 0 0 1.5 1.5h1.75"></path></svg>',
    '<span class="md-code-copy-label">Copy</span>',
    '<span class="md-code-copy-status" aria-live="polite"></span>',
    '</button>',
    '</div>',
    `<pre class="md-code-scroll"><code class="hljs${languageClass}">${highlightCode(code, language)}</code></pre>`,
    '</div>',
  ].join('');
}

renderer.html = function ({ text, block }) {
  // Rich-document compatibility Markdown uses only these attribute-free tags.
  // Other HTML remains escaped, including attributed variants of these tags.
  if (/^<br\s*\/?\s*>$/i.test(text)) return '<br>';
  if (/^<\/?u>$/i.test(text)) return text.toLowerCase();
  if (block && /^(?:<br\s*\/?\s*>|<u>)/i.test(text)) {
    return `<p>${this.parser.parseInline(Lexer.lexInline(text.trimEnd(), markdown.defaults))}</p>\n`;
  }
  return escapeHtml(text);
};

renderer.code = ({ text, lang }) => buildCodeBlockMarkup(String(text ?? ''), lang);

renderer.link = function ({ href, title, tokens }) {
  const mentionHref = sanitizeUrl(href, ['mention:']);
  if (mentionHref) {
    const label = this.parser.parseInline(tokens);
    const parts = mentionHref.replace(/^mention:/, '').split(':');
    const mentionType = normalizeRecordLinkType(parts[0] || 'unknown') || 'unknown';
    const mentionId = parts.slice(1).join(':');
    return buildMentionPillMarkup(label, mentionType, mentionId);
  }
  const storageHref = sanitizeUrl(href, ['storage:']);
  if (storageHref) {
    const label = this.parser.parseInline(tokens);
    return buildStorageFileCardMarkup(label, storageHref.slice('storage://'.length), title);
  }
  const fileHref = sanitizeUrl(href, ['file:']);
  if (fileHref) {
    const label = this.parser.parseInline(tokens);
    return buildReferenceFileCardMarkup(label, fileHref, title);
  }
  const safeHref = resolveMarkdownHref(href);
  const label = this.parser.parseInline(tokens);
  if (!safeHref) return label;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
};

renderer.image = function ({ href, title, text }) {
  const safeStorageHref = sanitizeUrl(href, ['storage:']);
  if (safeStorageHref) {
    return buildStorageImageMarkup(text, safeStorageHref.slice('storage://'.length));
  }

  const safeRemoteHref = sanitizeUrl(href, ['http:', 'https:']);
  if (safeRemoteHref) {
    return buildRemoteImageMarkup(text, safeRemoteHref, title);
  }

  const safeFileHref = sanitizeUrl(href, ['file:']);
  if (safeFileHref) {
    if (isImageHref(safeFileHref)) return buildRemoteImageMarkup(text, safeFileHref, title);
    return buildReferenceFileCardMarkup(escapeHtml(text || fileNameFromHref(safeFileHref)), safeFileHref, title);
  }

  const safeLinkHref = sanitizeUrl(href, ['http:', 'https:']);
  if (!safeLinkHref) return escapeHtml(text);
  const label = escapeHtml(text || href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safeLinkHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
};

renderer.checkbox = ({ checked }) => `<input type="checkbox" disabled ${checked ? 'checked' : ''} />`;

markdown.use({ renderer });

export function renderMarkdownToHtml(source, options = {}) {
  const normalized = normalizeDocumentMentionCardLinks(
    normalizeEscapedFileReferences(
      expandInlineReferenceLinks(source, options.inlineReferences),
    ),
  ).replace(/\r\n?/g, '\n');
  if (!normalized) return '';
  const rendered = markdown.parse(normalized, { async: false });
  return typeof rendered === 'string' ? rendered : '';
}

/**
 * Resolve pending storage images in rendered HTML to actual URLs.
 *
 * Finds all `<img … data-storage-object-id="ID" …>` tags that lack a `src`
 * and calls `resolverFn(objectId)` to obtain the URL. On success the `src` is
 * injected and the `md-storage-image-pending` class is removed. On failure the
 * tag is kept but marked with `md-storage-image-error`.
 *
 * @param {string} html  Rendered HTML string from `renderMarkdownToHtml`.
 * @param {(objectId: string) => Promise<string>} resolverFn  Async function
 *   that returns a URL for a given storage object ID.
 * @returns {Promise<string>} The HTML with storage images hydrated.
 */
export async function hydrateStorageImageMarkup(html, resolverFn) {
  if (!html) return html || '';

  // Match <img …data-storage-object-id="VALUE"…> tags that have no src attribute
  const storageImgRe = /<img\b([^>]*?)data-storage-object-id="([^"]+)"([^>]*?)\/?\s*>/g;
  const matches = [];
  let match;
  while ((match = storageImgRe.exec(html)) !== null) {
    // Only process if there is no src already set
    const fullTag = match[0];
    if (/\bsrc="/.test(fullTag)) continue;
    matches.push({ fullTag, objectId: match[2] });
  }

  if (matches.length === 0) return html;

  // Resolve all images concurrently
  const resolutions = await Promise.allSettled(
    matches.map(async ({ objectId }) => ({
      objectId,
      url: await resolverFn(objectId),
    })),
  );

  let result = html;
  for (let i = 0; i < matches.length; i++) {
    const { fullTag } = matches[i];
    const resolution = resolutions[i];

    if (resolution.status === 'fulfilled' && resolution.value.url) {
      const safeUrl = String(resolution.value.url).replace(/"/g, '&quot;');
      const hydrated = fullTag
        .replace('md-storage-image-pending', '')
        .replace(/class="([^"]*)\s*"/, 'class="$1"')
        .replace('<img ', `<img src="${safeUrl}" `);
      result = result.replace(fullTag, hydrated);
    } else {
      // Mark as error
      const errored = fullTag
        .replace('md-storage-image-pending', 'md-storage-image-error');
      result = result.replace(fullTag, errored);
    }
  }

  return result;
}
