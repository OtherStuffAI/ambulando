# Personal attention and Deck activity

Deck activity and unread attention are separate projections. Tower task and
article changes remain activity; attention represents another actor's qualifying
activity beyond the signed-in user's existing resource view position.

Unread threads retain their existing chat behavior. Task activity qualifies when
assigned to the reader or when a surviving comment has a structured mention of
that reader. Document body activity qualifies while the body has a structured
reader mention; unrelated comments do not advance the body position. Mentioned
comments qualify separately. Removing an assignment or mention never advances
an old mention's activity position. Own-authored activity follows existing Tower
view-state policy and is also excluded by the server-owned activity actor fields.

Tower adds `attention` alongside existing task/document fields:

- `policy_version: 1`
- `body_activity_version` and `body_actor_id`
- `mention_activity_versions`, keyed by canonical actor ID
- `last_activity_actor_id`

Tower may retain per-comment positions to recompute the mention map when comments
or mentions are removed. Flight Deck consumes the resulting canonical map.
Canonical `attention` takes precedence over a cached personalized view-state
projection, because removal can change eligibility at the same activity version.
Personalized view-state `attention_policy_version` and
`attention_activity_version` support hydration without parent rows. Existing
`activity_version`, `viewed_activity_version` and legacy `unread` remain compatible.
Visible mention text alone never grants attention eligibility. Canonical actor
IDs take precedence; historical structured npubs are accepted when no actor ID
was recorded. Encrypted compatibility clients retain their existing timestamp
read contract; upgraded PG clients use personal attention, with structured
identity/timestamp fallback when connected to an older Tower.

The record-delta materializer persists one projection in `pg_resource_attention`
and updates `pg_attention_counts` in the same transaction. Deck backgrounds,
item indicators, channel/section/navigation aggregates and unread filters use
that projection. A receipt can clear qualifying activity even if a newer neutral
update has a higher general activity version. Neither materialization nor saving
records marks them read. Opening a resource uses the existing view-state flow.

Standalone files remain neutral Deck entries. Thread/task attachments are excluded
from separate Deck entries at both source recovery and final feed assembly. Their
source records and parent attachment access remain intact.

## Existing caches and rollout

The existing bounded summary rebuild uses a new `summary-backfill-attention-v1`
checkpoint and `attentionPolicyVersion` marker. At the next complete delta pass,
TowerSyncService requests recomputation in resumable batches of at most 32 raw
rows. It preserves the canonical sync cursor, pending commands and per-user read
watermarks. Receiving a new view-state or canonical record subsequently updates
attention transactionally. No second network owner or cache reset is introduced.

Roll out additive Tower fields and the server's idempotent historical attention
backfill before activating the updated client. Backfill must use existing
canonical structured mention/activity evidence, preserve user view positions,
and recompute removed comment mentions; it must not initialize every row to an
empty attention map and discard historical unread mentions. A local Tower
activation does not update a remote record backend. Device checkpoints remain a
separate protocol and are unchanged by this client change.

## Single task assignee

Tower replaces primary metadata and relation rows in the same transaction.
Explicit primary metadata, including null, takes precedence over any old cached
relation row. A missing primary with multiple identities is unresolved and does
not grant assignment attention. Independent comment mentions keep their original
positions. The `summary-backfill-assignment-v2` pass repairs existing task
assignee/index fields and attention in bounded transactions, preserving pending
commands, device cursors and user viewed watermarks. Server repair and unresolved
history are described in Tower's `docs/task-single-assignee.md`.
