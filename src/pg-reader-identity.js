const text = value => String(value ?? '').trim();

// pgMe is Tower's actual-reader /me response, not workspace-owner authority.
export function resolvePgReaderActorId(store = {}) {
  const workspace = store.currentWorkspace || {};
  const sessionNpub = text(store.session?.npub);
  const me = workspace.pgMe || workspace.pg_me;
  if (!sessionNpub || text(me?.actor?.npub) !== sessionNpub
    || (workspace.pgSessionNpub && text(workspace.pgSessionNpub) !== sessionNpub)
    || (me?.identity?.workspace_id && text(me.identity.workspace_id) !== text(workspace.workspaceId))) return '';
  return text(me?.actor?.actor_id || me?.actor?.id);
}
