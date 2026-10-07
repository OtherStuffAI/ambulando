import { MESSAGE_ACTIVITY_RANGES } from './projection.js';

export function validMessageActivityRequest(event, frameWindow, session) {
  const data = event?.data;
  if (!frameWindow || event.source !== frameWindow || event.origin !== 'null'
    || !data || typeof data !== 'object' || Array.isArray(data)
    || data.version !== 1 || data.session !== session) return false;
  const keys = Object.keys(data).sort().join(',');
  if (data.type === 'range') return keys === 'range,session,type,version' && MESSAGE_ACTIVITY_RANGES.includes(data.range);
  return keys === 'session,type,version' && ['ready', 'refresh', 'close'].includes(data.type);
}

export function messageActivityError(error) {
  if (error?.status === 404) return 'Message activity is not available on this Tower yet. Ask the workspace manager to activate it, then refresh.';
  if ([401, 403].includes(error?.status)) return 'Message activity access denied. Reconnect to this workspace, then retry.';
  if (error?.name === 'TimeoutError') return 'Message activity timed out. Refresh to retry.';
  return 'Message activity could not be loaded completely. Refresh to retry.';
}
