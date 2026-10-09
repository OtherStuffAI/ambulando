export const DISABLED_FLIGHT_DECK_SURFACES = Object.freeze({
  schedules: true,
  flows: true,
  approvals: true,
  people: true,
  opportunities: true,
  reports: true,
  wappVisibility: false,
});

const DISABLED_SECTION_BY_SURFACE = Object.freeze({
  people: 'people',
  opportunities: 'opportunities',
  reports: 'reports',
});

const DISABLED_MESSAGES = Object.freeze({
  schedules: 'Schedules are disabled for this Flight Deck build.',
  flows: 'Flows are disabled for this Flight Deck build.',
  approvals: 'Approvals are disabled for this Flight Deck build.',
  people: 'People are disabled for this Flight Deck build.',
  opportunities: 'Opportunities are disabled for this Flight Deck build.',
  reports: 'Reports are disabled for this Flight Deck build.',
  wappVisibility: 'WApp visibility editing is disabled for this Flight Deck build.',
});

export function isFlightDeckSurfaceDisabled(surfaceId) {
  return DISABLED_FLIGHT_DECK_SURFACES[String(surfaceId || '').trim()] === true;
}

export function disabledFlightDeckSurfaceMessage(surfaceId) {
  const key = String(surfaceId || '').trim();
  return DISABLED_MESSAGES[key] || 'This Flight Deck surface is disabled.';
}

export function isFlightDeckSectionDisabled(section) {
  const normalized = String(section || '').trim();
  return Object.values(DISABLED_SECTION_BY_SURFACE).includes(normalized);
}

export function normalizeEnabledFlightDeckSection(section, preferences = null) {
  if (preferences && section === 'agents' && preferences.agentsEnabled !== true) return 'status';
  if (preferences && section === 'context' && preferences.contextEnabled !== true) return 'status';
  return isFlightDeckSectionDisabled(section) ? 'status' : section;
}

export function blockDisabledFlightDeckSurface(store, surfaceId) {
  if (!isFlightDeckSurfaceDisabled(surfaceId)) return false;
  const message = disabledFlightDeckSurfaceMessage(surfaceId);
  if (store) {
    store.error = message;
    if (surfaceId === 'reports') store.reportDeleteError = message;
  }
  return true;
}
