# Workspace member administration

Manage Workspace → Groups & Members → Members exposes **Remove from workspace**
beside each member for workspace administrators. It opens the existing exact
identity access inspection and Tower removal preview; only Tower's returned
`can_administer` enables the operation (currently the canonical owner). Self and
owner protection remain Tower preview decisions. The full npub must match before
confirmation; names and avatars never substitute identity.

After Tower accepts removal, the browser atomically retires that member from its
persisted directory and invalidates the workspace's cached member snapshots.
Local removal fences in `sync_state` hide delayed worker/reference-directory
upserts, including after reload offline. A complete directory request begun
after removal can prove explicit re-enrolment and clear the exact fence. The
existing live query updates open DM and mention choices without UI polling.
Failed commands do not retire members; failed follow-up reads cannot undo an
accepted removal or imply it should be repeated. A device-storage failure after
acceptance is reported separately and requires reconnect/refresh.

Existing conversations and attribution remain available wherever the remaining
reader has access. Direct/agent DM shortcuts and grant repair reject recipients
absent from the current workspace roster. New messages and replies to an old
two-person DM are blocked before clearing their drafts, and rechecked at the
write boundary; historical channels and messages are not deleted. Note to self
remains available. Tower still authorizes every actual write. This does not
delete a global identity, reset record cursors or alter another workspace.

Settings → Groups & Members → Members → Inspect access opens an online Tower
authority inspection for the selected actor. It shows the canonical Tower
`display_name` and full `npub`, followed by effective workspace, scope and channel
permissions. Permission labels and known scope/channel/group names explain the
access in plain language; exact permission codes, resource IDs and grant IDs
remain available in expandable details. Missing names are explicitly unavailable,
not guessed. Nostr profile names do not override administration identity labels.
The inspector is discarded when the selected workspace, endpoint or identity changes.

The canonical workspace owner can assign or revoke the explicit workspace
agent-manager role. Assignment requires checking the intention statement and
entering the selected member's exact full npub. The role supports human and
agent actor kinds, including legacy agents registered as human; it never
changes an actor's global kind. App and service actors are excluded. This role intentionally includes
all existing and future scopes and channels, including private channels. It
includes workspace management and working permissions, but no global authority,
organisation-data, napplet or personal daily-note access. It does not authorize
assigning this role or removing members. Existing `workspace.manage` grants do
not acquire this inheritance. Revoking the role leaves independent grants intact.

The owner can also preview member removal, review direct grants, groups, role
and consequences, then enter the exact member npub to confirm. Tower controls
the preview token, protection rules and removal transaction. Rejected removal
invalidates the local preview and requires a fresh preview. Removal does not
delete an actor or signing key, transfer access to a similarly named identity,
or erase historical messages, authorship or audit history. Other workspaces
are unaffected. Re-adding a person does not restore removed grants.

The client never changes memberships or manager roles just by upgrading or
opening the inspector. Every operation uses the existing signed Tower transport
and workspace command boundary; authority remains in Tower. Deploy the Tower
contract before publishing the client. Older Towers may reject these new
endpoints; their error is displayed and no mutation is inferred as successful.

Unit tests cover exact identity, workspace switching and explicit confirmation.
The Playwright administration flow uses only intercepted local synthetic Tower
requests and exercises desktop and mobile presentation without changing any real
workspace. Real signed Tower integration and live activation remain separate
release checks.
