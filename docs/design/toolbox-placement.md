# Toolbox and Apps

Toolbox is a dedicated shell page at /<workspace>/toolbox. Its labelled button
in the left navigation retains a tooltip and selected state when collapsed,
and uses the shell mobile drawer. The home Apps stack opens Message activity
and eligible personal WApps together. Agents retain their own stack.

Only the existing home stack is a supported placement location. Each Toolbox
entry has a Show in Apps checkbox. Hiding a launcher preserves registration,
personal-WApp ordering, settings editing, archive rules and launch behavior.
Toolbox uses the existing actor-filtered personal-WApp collection; it does not
broaden discovery or scope access. Duplicate record IDs appear once.
Message activity retains its sandbox, authorized service and lifecycle. Closing
the napplet restores focus to the visible Apps stack control when its original
pill was hidden by collapsing the stack.

Placement is local browser preference data in the existing shared Dexie
app_settings row, under appPlacements, partitioned by JSON [workspaceKey, viewer].
Workspace keys retain existing backend/workspace isolation; viewer uses the PG
actor ID, or session npub when no PG actor is available. Entry IDs are namespaced
as wapp:<record-id> and napplet:message-activity. Missing entries default to shown,
preserving existing launchers without mutating registrations. An atomic patch
updates one placement; liveQuery publishes saved preferences across tabs.
Rendering selects the current partition on workspace/viewer changes.

Preferences are not Tower records and never enter the sync outbox. They persist
across reload and normal workspace sync, but do not roam between browsers or
devices. No shared backend payload or schema was added.
