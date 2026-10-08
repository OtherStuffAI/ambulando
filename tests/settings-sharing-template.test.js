import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_PATH = resolve(process.cwd(), 'index.html');

describe('settings sharing template', () => {
  it('renders sharing groups from currentWorkspaceGroups', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('x-show="$store.chat.groupsLoading">Loading groups…</p>');
    expect(html).toContain('x-show="$store.chat.groupsLoadError" x-text="$store.chat.groupsLoadError"></p>');
    expect(html).toContain('x-show="!$store.chat.groupsLoading && !$store.chat.groupsLoadError && $store.chat.currentWorkspaceGroups.length === 0">No groups yet. Create one to start sharing.</p>');
    expect(html).toContain('x-show="$store.chat.currentWorkspaceGroups.length > 0"');
    expect(html).toContain('<template x-for="group in $store.chat.currentWorkspaceGroups" :key="group.group_id">');
    expect(html).toContain('x-model="$store.chat.shareInviteGroupId" :disabled="$store.chat.shareInvitePending || $store.chat.currentWorkspaceGroups.length === 0"');
    expect(html).toContain('x-show="!$store.chat.groupsLoading && !$store.chat.groupsLoadError && $store.chat.currentWorkspaceGroups.length === 0">Create a group first.</p>');
  });

  it('renders PG workspace member, nested group, and effective member controls', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('x-show="$store.chat.isTowerPgMode"');
    expect(html).toContain('x-model="$store.chat.pgWorkspaceMemberNpub"');
    expect(html).toContain('@submit.prevent="$store.chat.addPgWorkspaceMember()"');
    expect(html).toContain('@click="$store.chat.openSettingsTab(\'sharing\')"');
    expect(html).toContain('>Loading members and groups…</p>');
    expect(html).toContain('$store.chat.getPgGroupMemberCandidates(group.group_id)');
    expect(html).toContain('@click="$store.chat.addPgGroupMember(group.group_id)"');
    expect(html).toContain('$store.chat.getPgChildGroupCandidates(group.group_id)');
    expect(html).toContain('@click="$store.chat.addPgChildGroup(group.group_id)"');
    expect(html).toContain('@click="$store.chat.removePgChildGroup(group.group_id, childGroupId)"');
    expect(html).toContain('group.effective_member_npubs');
    expect(html).toContain('@click="$store.chat.startPgWorkspaceMemberProfileEdit(member)"');
    expect(html).toContain('@submit.prevent="$store.chat.savePgWorkspaceMemberProfile(member)"');
    expect(html).toContain('x-text="$store.chat.getShortNpub(member.npub)"');
    expect(html).toContain('$store.chat.getPgWorkspaceMemberGroupNames(member.npub)');
  });
});
