# Tower Usage

Tower Usage is a bundled Napplet in Toolbox. It defaults to shown everywhere,
uses the same browser-local viewer/workspace placement preferences as Message
activity, and has no install step or external runtime. Open the home Apps stack
on desktop or mobile, then choose Tower Usage. Toolbox remains the editing and
placement surface through the existing section navigation. Editing one napplet retains its stable
placement identity and never edits the other napplet's preferences.

Opening Tower Usage makes an explicit signed command read of
`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/storage-usage` on the selected
Tower endpoint. It is a transient command response, not a persisted record family
or workspace sync subscription. Refresh repeats that read; Tower controls the
bounded collector and cache. No collection runs from rendering or closed dialogs.
The dialog's response is keyed by endpoint, workspace UUID, app, viewer and
workspace-selection generation. Switching invalidates displayed bytes immediately,
then refreshes an open dialog; late responses cannot replace the new workspace.
Closing aborts the request and restores focus. The dialog traps keyboard focus.

Tower checks membership and `workspace.manage` before every read, including cache
hits. Workspace-wide aggregates can include private scopes, so channel-only access
cannot disclose them. A server without the additive route shows unavailable
measurements; there is no fallback to legacy billing or whole-server disk.

The response includes S3/object storage, database, graph, Git/Forgejo, GRASP and
other stores, including reasons for incomplete or unavailable measurements. Null
means unavailable; numeric zero means a completed measurement returned zero.
Bytes use binary units (B, KiB, MiB, GiB). Collection time is supplied by Tower and
shown locally. Totals are covered subtotals, include labelled logical database
estimates, and explicitly exclude unsupported coverage. No bandwidth, billing,
quota enforcement or deletion is involved.

See Tower's `docs/contract/workspace-storage-usage.md` for measurement scope,
provider ownership and activation requirements. Both the route and matching client
must be activated for a live workspace measurement; synthetic browser tests and
source fixture checks do not establish live provider coverage.
