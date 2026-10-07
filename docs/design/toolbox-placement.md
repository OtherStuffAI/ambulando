# Toolbox and Apps

Toolbox is a dedicated shell page at /<workspace>/toolbox. It follows the existing
section navigation: icon in the collapsed desktop rail, labelled button alongside
Deck/Chat/Tasks/Docs/Files/Agents/Context in the expanded horizontal section bar,
and the existing compact mobile section switcher. Buttons retain selected state,
keyboard support and horizontal scrolling.

Toolbox reuses the personal launcher settings rows previously in Setup. Add,
edit, archive, icon upload/URL and WApp server ordering retain their existing
controls and transport. Setup retains provisioning, delegation and publishing.
Message activity and WApps share the home Apps stack and one editor. Napplet
icons and mixed-stack positions use local preferences; its sandbox and lifecycle
are unchanged. Bundled napplets can be hidden, but cannot be archived or change
their runtime URL.

The editor supports shown/hidden plus visibility everywhere, only a selected
scope (including that scope's channels), or only an exact selected channel.
Selectors reuse loaded scope rows and the existing grouped channel selector.
Unavailable/archived/deleted targets remain restricted and editable; they never
fall back to everywhere. Toolbox lists all eligible actor-owned launchers even
when their placement does not match the current context. The launcher and launch
guard enforce the current context. A workspace/viewer change invalidates an open
editor's save. Personal WApps require a known matching actor before rendering.

Placement is local browser preference data in the existing shared Dexie
app_settings row, under appPlacements, partitioned by JSON [workspaceKey, viewer].
Workspace keys retain existing backend/workspace isolation; viewer uses the PG
actor ID, or session npub when no PG actor is available. Entry IDs are namespaced
as wapp:<record-id> and napplet:message-activity. Missing entries default to shown
everywhere. Build-2271 boolean entries remain readable and migrate to objects on
edit without losing false/hidden state. Objects contain shown, visibility,
scopeId, channelId, position and optional napplet iconUrl and displayTitle. Napplet titles default to
Message activity when no custom title exists; a custom title changes only browser
display labels, never the stable napplet identity or runtime. Atomic patches preserve
other settings/partitions and liveQuery publishes preferences across tabs.

Preferences never enter Tower records or the sync outbox and do not roam between
browsers/devices. No shared backend payload, schema or contract was changed.
