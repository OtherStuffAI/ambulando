// Tower deliberately uses typed 404s to conceal inaccessible context records.
// A missing route on an older runtime is a deployment error, not an ACL denial.
export function isContextAccessDenied(error) {
  if (error?.status === 403) return true;
  if (error?.status !== 404) return false;
  const code = error.code || error.payload?.code || error.payload?.error?.code || error.reason;
  return ['context_not_found', 'workspace_not_found', 'scope_not_found'].includes(code);
}
