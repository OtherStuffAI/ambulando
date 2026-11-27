# Detached Doc publication holds

A canonical thread membership transition that removes a Doc pauses automatic
publication of that source on this device. The source and its ACL remain unchanged.
This is the first web increment of shared thread artefacts; it does not add the
thread browser, retained editors, Send context or frozen retries.

The delta materializer consumes the existing
`metadata.ambulando_thread_artefacts = {version:1,items:[{kind,id}]}` schema.
Typed thread hydration consumes the same transition. Only a newer canonical
thread row with both an understood previous membership and an understood next
membership establishes removal. An initialized empty list establishes removal;
missing/unknown metadata, initial reads, stale rows and access loss do not.
Unrelated metadata and File members are untouched.

Device-local `sync_state` stores one hold generation per workspace/Doc and a
monotonic observation per thread. Observing the same removal through multiple
read paths cannot renew a hold, including after the user releases it. A later
removal renews it. These keys inherit the existing PG database partition, which
binds the account, Tower service, workspace service, app and workspace. They are
not shared record metadata. Delta acceptance and the hold write use one
transaction. No schema or server change is required.

The common Doc save boundary rechecks the durable hold after waiting for earlier
saves. The final Doc update adapter checks it again before starting the request.
Lifecycle autosave, reconnect and ordinary Docs entry use these boundaries.
The editor observes the hold with Dexie liveQuery, checkpoints local edits and
cancels remote autosave. Ordinary draft deletion returns false while held;
canonical acknowledgement and undo cannot silently remove recovery.

The labelled Save action holds editor interaction through acknowledgement and
release. Explicit Save authorizes only the displayed generation. Conflict/recovery
handling remains required; an open recovery can be explicitly reviewed and saved
with the same labelled action. Save failures and uncertain outcomes retain the
hold. Discard similarly holds interaction. Hold release and local draft removal
share a transaction and compare both the reviewed generation and exact persisted
draft revision. A newer draft or detach prevents release. Preserved draft copies
remain archived. Normal Docs autosave is unchanged when no hold exists.

A request already started before this device observes removal cannot be recalled.
This increment prevents queued or subsequent automatic publication after the
canonical observation, not server-side cancellation of an in-flight request.
Live independent native/web acceptance remains separate from synthetic database
and browser regression checks. Whole-thread pins/viewports, retained editors and
the Send save barrier/frozen enqueue are still outstanding parity work.
