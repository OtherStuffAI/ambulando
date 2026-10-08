import { orgDataContext, orgDataLifecycle } from './projection.js';

export const ORG_DATA_EDITOR_PERMISSIONS = ['org_data.read', 'org_data.write', 'org_data.schema'];
export function replaceEditorPermissions(current, selected) {
  return [...current.filter(p => !ORG_DATA_EDITOR_PERMISSIONS.includes(p)), ...ORG_DATA_EDITOR_PERMISSIONS.filter(p => selected.includes(p))];
}
export const orgDataPermissionsMixin = {
  orgDataPermissionMembers: [],
  orgDataPermissionsContext: '',
  orgDataPermissionsBusy: false,
  orgDataPermissionsError: '',
  orgDataPermissionsNotice: '',
  orgDataEditorPermissions: ORG_DATA_EDITOR_PERMISSIONS,
  async loadOrgDataPermissions() {
    if (!this.canAdminWorkspace || this.orgDataPermissionsBusy) return;
    const c = orgDataContext(this), context = orgDataLifecycle(c);
    this.orgDataPermissionsBusy = true; this.orgDataPermissionsError = ''; this.orgDataPermissionsNotice = '';
    this.orgDataPermissionMembers = []; this.orgDataPermissionsContext = context;
    try {
      const result = await this.getTowerSyncService().ensureLoaded('org-data-permissions', crypto.randomUUID(), { force: true });
      if (this.orgDataContextKey !== context) return;
      this.orgDataPermissionMembers = (result.members || []).map(m => ({ ...m, permissions: [...m.permissions], selected: m.permissions.filter(p => ORG_DATA_EDITOR_PERMISSIONS.includes(p)) }));
    } catch (error) { if (this.orgDataContextKey === context) this.orgDataPermissionsError = error?.message || 'Unable to load organisation data permissions.'; }
    finally { this.orgDataPermissionsBusy = false; }
  },
  async saveOrgDataPermissions(member) {
    if (!this.canAdminWorkspace || this.orgDataPermissionsBusy || !this.orgDataPermissionRows.includes(member)) return;
    const c = orgDataContext(this), context = orgDataLifecycle(c);
    this.orgDataPermissionsBusy = true; this.orgDataPermissionsError = ''; this.orgDataPermissionsNotice = '';
    try {
      const result = await this.getTowerSyncService().command('org-data.write', { path: 'permissions', method: 'POST', body: {
        actor_id: member.id, expected_permissions: [...member.permissions], permissions: replaceEditorPermissions(member.permissions, member.selected),
      } });
      if (this.orgDataContextKey !== context) return;
      member.permissions = [...result.permissions];
      this.orgDataPermissionsNotice = 'Direct permissions saved. Group permissions still apply.';
      if (this.orgDataOpen) await this.syncOrgData();
    } catch (error) { if (this.orgDataContextKey === context) this.orgDataPermissionsError = error?.status === 409 ? 'Permissions changed elsewhere. Reload permissions before saving again.' : error?.message || 'Unable to save permissions.'; }
    finally { this.orgDataPermissionsBusy = false; }
  },
};
