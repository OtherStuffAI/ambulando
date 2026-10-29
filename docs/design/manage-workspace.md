# Manage Workspace navigation and action parity

The browser keeps all existing administration panels and commands, organised
under **Manage Workspace**, with selected workspace name/avatar above the
navigation. **Personal & Device** contains Deck, Notifications and Connection &
Diagnostics. The workspace switcher and profile menu both offer Manage Workspace.
The profile menu also offers Settings and Connection & Diagnostics directly.
Healthy connection status is compact; failure status links to recovery. Retry,
diagnostics and the existing NStack configuration appear only in that section.

This is a web-source audit, not evidence of native delivery. Native destinations
below are the parity contract for iPhone pushed screens and Mac section/detail
navigation. Native implementation and authenticated backend evidence must be
reported separately. Android is deferred. No shared contracts change here.

## Navigation compatibility

`navSection=settings` and existing `settingsTab` values (`workspace`, `scopes`,
`sharing`, `permissions`, `apps`, `deck`, `notifications`, `connection`, `data`)
remain intact. Existing scope access links and programmatic entry points still
select the same handlers. Manage Workspace lands on Workspace for admins,
Scopes & Channels for readers with scope settings, otherwise Apps & Integrations.
It grants no authority. Permissions and Apps remain discoverable to delegated
users; their exact commands still require Tower authorization. The navigation
uses ordinary keyboard buttons with current-page indication and wraps into two
labelled groups on phones. All existing panels remain mounted within Settings,
so switching sections does not discard a recoverable editor draft.

## Action matrix

Route prefix `W` means `/api/v4/flightdeck-pg/workspaces/:workspaceId`.
All Tower PG requests use the existing signed NIP-98 transport in `src/api.js`,
with the selected backend and app namespace. `src/tower-command-intents.js` and
`src/tower-command-port.js` own command dispatch; Tower owns exact permissions,
revision/lease checks and final authorization. Client visibility never proves
write authority. Offline column `online` means a direct command must succeed;
there is no new admin outbox or queued success. Existing errors/drafts remain.

| Action | Owning browser module / handler | Authority / API support | Web → iPhone/Mac destination | Offline / evidence and gaps |
| --- | --- | --- | --- | --- |
| View workspace identity | `workspace-manager.js`: currentWorkspaceName/AvatarUrl, profile hydration | Accessible workspace descriptor and persisted metadata; `GET W/descriptor` | Manage Workspace header → selected workspace header | Cached identity available; sparse remote metadata must not erase good local values. `workspace-manager`, `pg-workspace-manager` tests. |
| Edit name, description, avatar URL/file, slug, feature flag | `workspace-manager.js`: saveWorkspaceProfile, uploadWorkspaceAvatarFile | canAdminWorkspace; `PATCH W`; upload uses existing storage prepare/upload contract in `api.js`; changed slug requires confirmation because links break | Workspace → Workspace details | Online; form kept after error; slug confirmation, upload and denied profile tests in `workspace-manager`, `pg-workspace-manager`. Dashboard greeting and advanced checkbox remain in this panel. |
| Delete workspace or remove saved browser entry | `workspace-manager.js`: removeWorkspace | PG admin path `DELETE W` with existing confirmation; Nostr removal marker and local cleanup follow existing contract; non-admin removal is local-only where reachable | Workspace → Danger zone / native Workspace → explicit destructive confirmation | Online deletion; local removal does not delete Tower. `pg-workspace-manager` tests. No destructive live test performed in this change. |
| Reset profile draft / refresh Nostr profile cache / advanced preference | `workspace-manager.js`, `people-profiles-manager.js`, index.html | Existing local reset/profile-cache reads; advanced options stored per workspace on device | Workspace → existing actions | Preserve unsaved form reset and existing profile refresh; no authority expansion or record purge. |
| Create scope and template channels/default access | `scopes-manager.js`: addScope, wizard; `scope-templates.js` | Admin creation; `POST W/scopes`, then `POST W/scopes/:scopeId/channels`, existing grant APIs | Scopes & Channels → New scope wizard | Online; multi-step create may partially succeed; report existing errors, no atomic-success claim. `scopes-manager` tests. PG scopes are top-level; legacy hierarchy is not a new requirement. |
| Edit scope title/description/template fields | `scopes-manager.js`: saveEditScope; `pg-edit-session.js` | Exact scope manage capability, canonical edit lease/revision; `PATCH W/scopes/:scopeId` | Scopes & Channels → scope settings | Online; fields and errors remain. `scopes-manager`, `pg-edit-session` tests. |
| Archive scope | `scopes-manager.js`: confirmDeleteScope/confirmPendingScopeDelete; `pg-archive-state.js` | scope.manage; `DELETE W/scopes/:scopeId` archives scope and channels; protected DM/system targets rejected | Scopes & Channels → Archive confirmation | Online; content/grants retained; pending drafts preserved; no purge/cursor reset. `scope-order-archive`, `scopes-manager` tests. Restore is not exposed by existing web UI. |
| Personal scope order, drag or Move Up/Down | `scopes-manager.js`: savePersonalScopeOrder/moveScope; `scope-order.js` | Actual reader; `GET/PUT W/me/scope-order`, expected_row_version and mutation UUID | Scopes & Channels → personal ordering | Online save; persisted reactive order survives reload; conflicts require another explicit move. `scope-order`, `scopes-manager` tests. Never changes shared scope positions. |
| Create/edit channel and settings | `channels-manager.js`: createChannel/saveChannelSettings; scope wizard | Existing scope/channel capabilities; `POST W/scopes/:scopeId/channels`, `PATCH W/channels/:channelId` | Scopes & Channels → expanded scope/channel settings | Online; existing edit leases, saving/failed states; `channels-manager`, `channels-manager` tests. |
| Channel order | `channels-manager.js`: moveScopeChannel/dropScopeChannelBefore | Exact channel.manage; `POST W/channels/:channelId/reorder` with 1-based position | Scopes & Channels → Move Up/Down or drag | Online; rollback visual order on failure; sparse acknowledgements preserve grants. `channel-order` tests. Shared order, unlike personal scope order. |
| Archive channel / DM conversation | `channels-manager.js`: deleteChannel; `pg-archive-state.js` | channel.manage; `DELETE W/channels/:channelId`; system channels protected | Scopes & Channels / conversation menu → Archive confirmation | Online; global archive affects all participants, not personal hide. Retains content/grants. Archive tests; no restore UI claimed. |
| View scope effective access, grant Context editor/Scope manager, revoke role grants | `scope-access-manager.js`: openScopeAccess/saveScopeAccess | can_manage from exact scope access; `GET/PUT W/scopes/:scopeId/grants`; canonical lease + expected_revision | Scopes & Channels → scope Access | Online; preserve custom/inherited grants; stale/denied handling, selected canonical principal required. `scope-access-manager` tests. No authority inferred from legacy context-edit alias. |
| Workspace members: list/add npub, human/agent identity, profile | `channels-manager.js`: addPgWorkspaceMember; `people-profiles-manager.js` | Admin surface; `GET/POST W/members`, `PATCH W/members/:actorId/profile`; new member role is member | Groups & Members → Members | Online additions; cached reactive list; `channels-manager`, `people-profiles-manager`, groups browser tests. Existing web has no general remove-member/role-promotion command; do not invent parity. |
| Create group | `channels-manager.js`: createSharingGroup | Admin; `POST W/groups`; optional member creation + additions | Groups & Members → New group | Online; multi-command partial result possible. `channels-manager` tests. |
| Add/remove group members | `channels-manager.js`: saveEditGroup; actor identity resolved before removals | Admin; `POST W/groups/:groupId/members`, `DELETE W/groups/:groupId/members/:actorId` | Groups & Members → group members | Online; missing stable actor ID blocks before additions, keeps selection; `channels-manager` tests. Protected group lifecycle safeguards retained. |
| Nested groups add/remove | `channels-manager.js`: addPgChildGroup/removePgChildGroup | Admin; `POST W/groups/:parentId/child-groups`, `DELETE W/groups/:parentId/child-groups/:childId` | Groups & Members → group child groups | Online; existing cycle/system safeguards remain Tower-owned; `channels-manager` tests. |
| Rename/delete group | `channels-manager.js`: saveEditGroup/deleteSharingGroup | **PG unsupported in current web adapter**; explicit errors. Legacy `PATCH/DELETE /api/v4/groups/:id` through api.js | Groups & Members → explicit unsupported gap for PG | Never count as completed native PG parity. Protected private/shared/admin groups cannot rename/delete. Legacy encrypted group rotation remains on existing path. |
| Channel access list/add/change/revoke; bulk preview/apply/retry | `channels-manager.js`: channel-grant and bulk helpers | Exact channel grant-management capability; `GET/POST W/channels/:id/grants`, `PUT/DELETE W/channels/:id/grants/:principalType/:principalId` | Groups & Members → Channel access; channel settings → Access | Online; per-channel failure/partial results, custom grants preserved, review required before writes. `channels-manager-mixin`, `groups-members-access` browser tests. Never auto-select all channels. |
| Organisation direct permissions | `org-data/permissions.js`: loadOrgDataPermissions/saveOrgDataPermissions | Existing admin/editor permissions; `GET/POST W/org-data/permissions` | Groups & Members → Members → Organisation data permissions | Online; inherited group access remains when removing direct grants. `org-data-permissions` tests. |
| Narrow WApp management delegation create/list/revoke | `wapp-management-manager.js`: saveWappDelegation/revokeWappDelegation | Admin grant/revoke; delegate can view permitted records; `GET/POST W/wapp-delegations`, `POST W/wapp-delegations/:id/revoke` | Permissions → WApp management | Online; exact target/filter/expiry, no workspace-admin escalation. `wapp-management-manager`, `tower-command-wapp` tests. |
| Discover app / install and assign Feed authority | `wapp-management-manager.js`, `wapp-autopilot-service.js` | Exact admin/delegated wapp.manage filters; `GET W/wapp-install-intents`, `POST W/wapp-install-intents`; Autopilot `GET /api/wapps/activation-catalog`, `POST /api/wapps/install-intents/process` | Permissions → Install and assign; native Apps & Integrations may link here | Online; owner approval remains required when server says step_up_required. `wapp-management-manager` tests; no promise of all apps or transports. |
| Installation list/reconcile/revoke | `wapp-management-manager.js`: refreshWappManagement/reconcileManagedWapp/revokeManagedWapp | Exact authority; `GET W/wapp-installations`, `POST W/wapp-installations/:id/reconcile` or `/revoke` | Permissions → Installations / native Apps & Integrations | Online; authority revocation and runtime teardown are separate. Uninstall… currently only explains owner approval; **not a completed uninstall capability**. |
| Publishing installation add/edit/destinations/origins/expiry; disable/revoke/rotate | `wapp-publishing-manager.js` | Existing owner/delegation checks; `GET W/wapp-publishing-grants`, `GET/PUT W/wapp-publishing-grants/:installationId`; `POST` same path + `/disable`, `/revoke`, `/rotate` | Apps & Integrations → Ambulando publishing | Online; exact signed request, canonical identity and existing capabilities; `wapp-publishing-manager`, `wapp-publishing-ui`, `tower-command-wapp` tests. |
| Personal launcher create/edit/reorder/delete | `toolbox-manager.js`, `wapp-publishing-manager.js` | Actor-owned personal WApps; `GET/POST W/personal-wapps`, `PATCH/DELETE W/personal-wapps/:id`, `POST W/personal-wapps/reorder` | Toolbox; publishing editor → personal launcher / native Toolbox | Existing personal contract; no workspace authority inferred from launcher. `wapps-db`, `wapp-publishing-manager` tests. |
| Clear unavailable saved workspaces | `workspace-manager.js`: clearUnavailablePgWorkspaces | Local discovery cleanup after verifying saved PG workspaces; not workspace deletion | Apps & Integrations → App Management cleanup | Requires verification; preserves available workspaces. Device-only operation kept, labelled explicitly. `pg-workspace-manager` tests. |
| Deck theme, Inbox/My Focus/Agents/Context visibility | `appearance.js`, app/shell preference helpers; index.html Deck panel | Personal/device settings; local storage, no admin | Settings → Deck → native personal settings where supported | Local immediate; theme and optional-view tests. No removal of existing options. |
| Nostr viewer preference | `feed/nostr-viewer.js` | Actor-private preference; default njump, custom URL; existing private preference sync | Settings → Deck → native personal settings parity audit | Local/private sync semantics, not shared workspace policy. Nostr viewer tests. |
| Notifications: browser permission, sound, push, actor preferences/devices | `notifications-manager.js`, `notification-inbox-manager.js` | Personal identity; `GET W/notifications/settings`, `PUT W/notifications/preferences`, `POST/DELETE W/notifications/subscriptions[/:id]` | Settings → Notifications → native Notifications | Device/browser restrictions remain; offline cached choices not proof of push registration. Notification tests. |
| Personal default agent; workspace harness/triggers and advanced options | `workspace-manager.js`: saveHarnessSettings; existing connection panel | Personal agent settings use `PUT W/me/autopilot-agents`; shared operator settings retain existing admin checks/settings write path | Connection & Diagnostics → existing advanced settings / native advanced connection | Preserve mixed legacy semantics; do not broaden shared writes. `workspace-manager`, connection settings tests. |
| Tower/NStack configuration, discovery/recovery; Autopilot/FIPS | `connect-settings-manager.js`, `nstack-connection.js`, `autopilot-connect-client.js` | Existing signer/transport capabilities; connection config never grants administration | Settings → Connection & Diagnostics → native connection/diagnostics | Cached controls available during failure; unsupported native transport explicitly unresolved; no HTTPS fallback for scoped FIPS handles. |
| Retry, diagnostics/export/report consent | `sync-manager.js`: retrySettingsConnection; diagnostics manager/worker | Existing recovery/signing; read-only resource-view-state refresh, no cache purge or cursor reset | Compact status → Connection & Diagnostics → Retry / Diagnostics | Failure is visible; cached records/drafts retained. Consent/redaction and connection recovery tests. |
| Legacy Sync, schedules/flows | index.html; existing sync/schedule managers | Existing advanced and disabled-product guards unchanged | Personal & Device → Sync (legacy only); disabled schedules/flows stay disabled | Do not count disabled surfaces as parity or enable them in redesign. |

## Evidence boundaries and inherited gaps

Navigation changes add no network work, storage family or authority inference.
Lists continue through existing Dexie/liveQuery and TowerSyncService paths; heavy
materialisation stays in the existing worker. Direct admin commands still await
acknowledgement. Web tests cover many command contracts through mocks or synthetic
loopback Tower; this is distinct from live authorized and denied account testing.

The existing group rename/delete PG errors, missing general membership removal
and role-changing web commands, explanatory uninstall button, and legacy-only
hierarchy/Sync are explicit capability gaps. They must not be replaced by native
placeholders and counted as parity. Installation/delegation result state in the
existing WApp manager is transient (not a new persisted collection); its async
workspace-switch handling needs independent coverage before claiming complete
cross-workspace command isolation. This navigation change does not fix or certify
all inherited administration flows. See the task evidence for the exact run,
build, runtime and authenticated coverage achieved.
