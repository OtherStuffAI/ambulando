import { normalizeEnabledFlightDeckSection } from './disabled-surfaces.js';

export const KNOWN_PAGES = new Set([
  'flight-deck', 'notifications', 'status', 'tasks',
  'chat', 'docs', 'files', 'drive', 'reports', 'opportunities', 'people', 'settings',
  'workroom', 'workrooms', 'agents', 'context',
]);

export function pageToSection(page) {
  if (page === 'flight-deck' || page === 'notifications' || page === 'status') return 'status';
  if (page === 'workroom' || page === 'workrooms') return 'workroom';
  if (page === 'drive') return 'files';
  if (KNOWN_PAGES.has(page)) return normalizeEnabledFlightDeckSection(page);
  return null;
}

/**
 * Build a section URL that always carries scopeid when present.
 * @param {object} opts
 * @param {string} [opts.workspaceSlug] - workspace slug for the path prefix
 * @param {string} opts.section - target section (tasks, chat, docs, etc.)
 * @param {string|null} [opts.scopeid] - active scope to preserve across navigation
 * @param {object} [opts.params] - additional query params (channelid, taskid, etc.)
 * @returns {string} pathname + search string
 */
export function buildSectionUrl({ workspaceSlug, section, scopeid, params } = {}) {
  const workroomId = params?.workroomid || params?.workroomId || null;
  const page = section === 'status' ? 'flight-deck' : section === 'workrooms' ? 'workroom' : section;
  const pathname = (section === 'workroom' || section === 'workrooms') && workroomId
    ? `${workspaceSlug ? `/${workspaceSlug}` : ''}/workroom/${encodeURIComponent(workroomId)}`
    : (workspaceSlug ? `/${workspaceSlug}/${page}` : `/${page}`);

  const searchParams = new URLSearchParams();
  if (scopeid) searchParams.set('scopeid', scopeid);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (key === 'workroomid' || key === 'workroomId') continue;
      if (value) searchParams.set(key, value);
    }
  }

  const search = searchParams.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export function parseRouteLocation(href) {
  if (typeof window === 'undefined' && !href) {
    return { section: 'status', params: {}, workspaceSlug: null };
  }

  const url = new URL(href || window.location.href);
  const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  let workspaceSlug = null;
  let section = 'status';
  let pathWorkroomId = null;

  if (segments.length === 0) {
    // Root path: /
  } else if (segments.length === 1) {
    // Either /<page> (canonical or backward compat) or /<slug> (workspace root)
    const mapped = pageToSection(segments[0]);
    if (mapped) {
      section = mapped;
    } else {
      workspaceSlug = segments[0];
    }
  } else if (segments[0] === 'workroom' || segments[0] === 'workrooms') {
    // Backward-compatible bare workroom detail route: /workrooms/<id>
    section = 'workroom';
    pathWorkroomId = segments[1] ? decodeURIComponent(segments[1]) : null;
  } else {
    // /<slug>/<page>
    workspaceSlug = segments[0];
    const mapped = pageToSection(segments[1]);
    if (mapped) section = mapped;
    if (segments[1] === 'workroom' || segments[1] === 'workrooms') {
      section = 'workroom';
      pathWorkroomId = segments[2] ? decodeURIComponent(segments[2]) : null;
    }
  }

  const driveReference = url.hash.startsWith('#drive?') ? new URLSearchParams(url.hash.slice(7)) : null;
  if (driveReference) { section = 'files'; workspaceSlug = null; }
  return {
    section,
    workspaceSlug,
    params: {
      channelid: url.searchParams.get('channelid') || null,
      threadid: url.searchParams.get('threadid') || null,
      folderid: url.searchParams.get('folderid') || null,
      docid: url.searchParams.get('docid') || null,
      versioning: url.searchParams.get('versioning') || null,
      commentid: url.searchParams.get('commentid') || null,
      scopeid: url.searchParams.get('scopeid') || null,
      descendants: url.searchParams.get('descendants') || null,
      groupid: url.searchParams.get('groups') || url.searchParams.get('groupid') || null,
      reportid: url.searchParams.get('reportid') || null,
      opportunityid: url.searchParams.get('opportunityid') || null,
      taskid: url.searchParams.get('taskid') || null,
      agentid: url.searchParams.get('agentid') || null,
      agentview: url.searchParams.get('agentview') || null,
      workroomid: pathWorkroomId || url.searchParams.get('workroomid') || null,
      view: url.searchParams.get('view') || null,
      sort: url.searchParams.get('sort') || null,
      workspacekey: driveReference ? null : url.searchParams.get('workspacekey') || null,
      workspaceid: driveReference?.get('workspace') || url.searchParams.get('workspaceid') || url.searchParams.get('workspace_id') || null,
      token: url.searchParams.get('token') || null,
    },
  };
}
