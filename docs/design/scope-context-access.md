# Scope Access editor

In a Tower PG workspace, open **Setup → Scopes → the scope’s ⋮ menu → Access**. A scope manager can choose People, Agents or Groups, select the named principal, choose Context editor or Scope manager, and Save access. For Rick, choose Agents, Rick, Context editor, Save access. This release does not assign him.

Context editor edits the component hierarchy and direct references, including confirmed subtree deletion. Scope manager also administers the scope and its grants. Access applies to the exact scope; child scopes, channels and linked content retain their separate access checks. Group membership is resolved by Tower, including established nested groups. Effective access identifies direct grants and the granting group; revoke group authority on that group’s grant row.

Roles translate to Tower canonical permissions, not locally stored authority. Save adds the selected permission and preserves all existing grants. To narrow an existing Scope manager, explicitly revoke role grants then add Context editor; custom grants remain. A reader sees their own effective access and cannot edit grants. Tower supplies management-only canonical principal choices under scope.manage, so a scoped manager does not need unrelated workspace directory grants. Names are displayed; stable actor/group IDs stay in requests.

Reads use TowerSyncService; commands use the shared Tower command registry. Grant command responses are transient access-editor state. Context collections remain in Dexie and liveQuery. Each save acquires and consumes an existing canonical scope edit lease and submits the loaded grant revision; stale or held leases require refresh. Workspace switching hides access state from the prior workspace.

Tower exposes additive context capabilities `edit` and `scope_manage`; legacy `manage` remains a compatibility alias for context editing. The context editor uses `edit` when available and the alias with older Tower responses. It never derives scope administration from that alias.

Validation separates disposable server signers and labelled browser fixtures from the real reader session. Live reader screenshots/probes cannot prove Pete’s manager save flow without Pete using his signer; tests do not impersonate him or modify production grants. Autopilot CLI/MCP source descriptions can be updated without restarting Autopilot; loaded MCP descriptions/handlers remain a separate activation boundary.
