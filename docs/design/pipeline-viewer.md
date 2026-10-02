# Autopilot pipeline viewer

Flight Deck reads a selected, identity-verified Autopilot installation through
its existing connection client. `pipelines.viewer.read.v1` and the exact signed
`pipeline_viewer_path` are required. Old clients and Agent Space management views
remain compatible; missing viewer capability is explicitly unavailable.

The connection client signs owner-scoped GET requests with explicit workspace,
Tower service and app context, and the selected agent binding where available.
It uses the existing immutable peer-pinned FIPS handle. HTTPS metadata is never
a fallback for a selected FIPS connection. Service identity is installation ID
plus installation signer, independently of its endpoint.

`pipeline-viewer-service.js` owns reads, cancellation and bounded recovery.
`pipeline-viewer-store.js` writes small projections to workspace Dexie tables;
`pipeline-viewer-view.js` observes those projections with liveQuery. These local
execution projections are not Tower record families and do not participate in
TowerSyncService replication or its outbox. Definition ports, persisted summaries
and the rendered diagram are separate shapes.

Snapshots replace the authoritative run projection, including all attempts,
without merging replayed execution IDs. SHA-256 revision tokens are opaque:
compare-and-swap against the preceding revision and coalesced requests prevent
late responses from replacing a newer projection. Recovery requests a fresh run
snapshot. Native statuses, completion timestamps, skip/continuation/exit reasons
and child references retain their backend meanings. Logical node attempts and
executor evidence retries have separate attempt numbers.

Full evidence is lazy and lives only in an explicit in-memory session cache.
Changing workspace, actor, service, agent context or run aborts requests and clears
private values. They never enter Dexie, localStorage, logs or URL parameters.
Denied/unavailable reads clear the corresponding projection; disconnected reads
retain summaries marked stale. Arrays page until `nextOffset` is null, with no
first-N ceiling. A partial page is not labelled complete. Search describes its
loaded-page scope and complete-value copy requires every retained page. Redacted
retained values identify their redaction metadata and remain distinct from
preview-only, expired, not-captured and unavailable evidence.

The diagram uses actual definition nodes and children. No display-only groups
are inferred. Measured SVG links connect actual source and target port buttons, with named field
labels and a keyboard-accessible connection ledger. Configured selector wiring and carried-forward metadata are labelled
separately; neither claims every internal read. Child navigation keeps a parent
trail. When a historical definition is unavailable, only recorded execution nodes
are shown, without rebuilding from the latest catalogue definition.

All untrusted values use text bindings. Hover/focus provides a preview; click/tap
pins exact evidence. Escape closes and returns focus. Desktop steps run horizontally;
small screens use a vertical sequence with a bounded pinned inspector in the viewport. Controls expose
labels, test IDs and live status feedback; technical identifiers are optional.

The reusable synthetic browser harness blocks backend access. Backend-generated
contract fixtures verify real Bird structure, native statuses, revision tokens,
child relationships and paginated evidence. Product activation remains dependent
on compatible backend availability and a fresh signed connection capability.

Optional backend `EvidenceReference.preview` contains only a redacted bounded
capture summary (maximum 2048 UTF-8 JSON bytes), explicit truncation and collection
counts. The service keeps even these excerpts session-only and strips them before
Dexie writes. Older missing previews stay explicitly unavailable. Focus/hover
never fetches full evidence; pinning does. Exact port selection includes logical
node, input/output side, path, execution and evidence identity. Latest durable
capture order selects the winning output; each execution remains inspectable
separately. Null and absent paths are explicit and never substitute a whole object.
All loaded records have an exact-copy action; full-value copy requires complete
retention and excludes sibling fields.

Navigation guards check both context generation and selection ticket after reads,
so stale selections cannot update the URL or child trail. Nested authority and
capability changes retrigger context validation. Production-shell tests route-serve
an isolated real Vite build and mock only external transport/signing and unrelated
workspace startup work. They seed verified installation/context records, release
actual delayed promises and exercise service collision/history/revocation/recovery.
Known hidden WApp null-draft boot errors are recorded separately from viewer errors.

Wiring's additive `sourceValuePath` is relative to the captured writer output;
`sourcePortPaths` and `targetPortPaths` identify declared ports related to each
configured selector. The renderer pairs descendant fields only when their relative
paths match (for example retrieval tweets to input state tweets). Otherwise it
shows the explicit configured selector endpoint. Older DTO source state selectors
use exact `state_write` evidence, keeping them separate from returned output.
No prefix guessing or whole-object substitution supplies a missing named field.

Loaded array inspection renders navigable pages of 50 records. Previous/Next and
an editable page number expose every loaded record; search covers the entire
loaded collection and returns to page one. Rendering pages do not change transport
pagination, complete-value copy, or the exact original record numbering. The
session's serialized search index clears with the inspector/context. A 5,000-record
browser regression checks bounded DOM, last-page and search access, and exact copy
on desktop and touch layouts.

Optional preview `fields` maps exact declared display paths to
`{present, value, truncated, count}` captured after backend redaction. The frontend
validates the entire preview's 2 KiB UTF-8 budget and keeps the map session-only.
Per-field counts and truncation describe that selected field; `present: false`
distinguishes missing from explicit null. A missing map entry is outside the
bounded preview. Older previews without a map retain generic path selection.
Full inspection always selects the exact path from lazy retained evidence; no
preview field or alias replaces a missing full value. New Bird root Delivered
metadata selects `$.delivery.delivered`; historical captured definitions retain
their original paths.

The viewer release flag defaults OFF. Only the exact build environment opt-in
`FLIGHTDECK_PIPELINE_VIEWER_ENABLED=1` enables its navigation, deep-link mount and
service initialization. Disabled builds show pending activation for explicit
viewer requests and issue no viewer health, catalogue, snapshot or evidence
reads. Runtime capability checks still apply in enabled builds. Before enabling
publication, activate and verify the compatible backend, signed capability,
authorization, pinned transport and isolated live preflight. An isolated opted-in
acceptance build is source validation, not deployment permission. Default builds
therefore preserve this boundary when other features are published.
