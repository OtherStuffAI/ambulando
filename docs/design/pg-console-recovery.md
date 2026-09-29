# PG console recovery boundaries

PG workspace membership is owned by Tower's typed Flight Deck authority. The
legacy `/api/v4/user/workspace-keys` route validates the legacy workspace
directory, so a PG workspace service identity must not be registered there.
Flight Deck's PG bootstrap clears an active legacy delegation key and uses its
existing real-actor NIP-98 signing fallback. Legacy bootstrap, delegation cache,
and registration behavior remain available in legacy mode. Enabling PG
workspace delegation requires an explicit Tower registration contract that
validates PG membership; it cannot be inferred from a shared owner identity.

## Superseded reads

Scope, channel, message and conversation reads capture the active cursor,
generation, staging/reset state and local command revision. The commit checks
that authority in its Dexie transaction. Typed `pg_read_authority_resetting`
and `pg_read_authority_changed` cancellations never commit or mark the family
fresh. The sync request owner joins the coalesced workspace pull when staging
owns authority and retries the read. After three superseded attempts it defers
to background recovery. Persisted views remain readable throughout. Network,
permission, malformed-response and transaction errors still reject.

SSE retains its existing bounded retry and commit-before-acknowledgement
behavior. Expected typed read cancellations are trace events rather than
console warnings. They do not acknowledge an uncommitted batch.

## Optional session health

The `agent-session-health` read requires `pg_agent_session_health` in the live
workspace capabilities or descriptor. Current Tower does not advertise or
implement that contract. An absent capability skips the optional read without
clearing retained health or suppressing turn activity/commentary recovery.
Every hydration evaluates the current descriptor, so a refreshed advertisement
can enable the read. Advertised route failures remain errors. A future Tower
implementation must advertise the capability alongside the route.

## Stale reaction hints

A reaction read accepts only two missing-resource contracts: 404
`reaction_target_not_found`, or 400 `resource-not-found` with
`required_permission: channel.read`. Tower's second response means its
resolved target channel is archived or missing before grant authorization.
It is distinct from a 403 `permission_denied`. Other errors remain visible.

Confirmed missing targets clear their local reactions and enter a 30-second
negative cache scoped by workspace, backend, app, actor and activation. Replay
hints cannot repeat a futile read inside that interval. Expiry allows restored
targets to recover. This does not cache or reinterpret permission denials.

## Transaction failures

Transaction failures are not expected cancellations. Worker errors retain the
original name and stack plus operation, protocol, mode, change count and
pagination state. Startup, SSE and polling share a console rate limit for the
same transaction failure in the same workspace: one actionable diagnostic per
minute, with every retry retained in the bounded trace buffer. The Update
stalled state, retry action, cursor rollback and SSE acknowledgement rules
remain active. Different errors or workspaces produce a new diagnostic.

No transaction lifetime root cause is established by the console report alone.
The eight-page, 1,600-message browser regression runs the actual materialization
worker, publishes only at handover, and verifies a following delta succeeds.
Fake IndexedDB coverage separately checks publication rollback and retained
staging on failure. These probes cannot prove recovery of an affected browser's
particular cache or runtime. Capture the original worker stack and reproduce
that state before changing transaction structure.

Regression coverage lives in `pg-cache-continuity`, `pg-read-hydrator`,
`sync-manager`, `shell-state-pg-startup`, `pg-sync-failure-logging`,
`tower-pg-materialization-worker-client`, and
`tests/e2e/pg-console-transactions.spec.cjs`. The editor regression verifies one
Link extension with the configured click, autolink and paste behavior.
