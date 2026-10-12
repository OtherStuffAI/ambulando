# Selected-message branch inheritance

A branch inherits its parent's effective transcript through the selected message,
inclusive. Later parent replies remain outside that branch. Selecting an inherited
message branches from the active effective thread, while retaining the selected
message's record ID as the boundary. Selecting an own reply of a branch retains
its inherited prefix and its own replies through that selection.

The message-action buttons pass a record ID to `branchFromMessage`. The write
adapter sends `branch_point_message_id` to the parent thread's branches endpoint.
Thread mapping persists `pg_parent_thread_id` and `pg_branch_point_message_id`;
history hydration persists effective membership separately from message values.
No new wire fields or shared backend contract changes are required.

`thread-history-coverage.js` clamps ordered membership at the selected boundary.
After that boundary, only messages owned by the child thread remain. Explicit
`owning_thread_id` takes precedence over `thread_id`: an effective transcript may
use the child thread ID for presentation while the message still belongs to an
ancestor. Treating either ID as child ownership leaks later parent messages.

The local bounded view must retain the boundary in membership metadata until
clamping completes. Taking the last visible IDs first can discard an early branch
point, disabling the cutoff on reopen. The view reads only a bounded tail of
message values for ownership, clamps the complete ID metadata, then reads the
bounded visible result. Indexed own-thread replies remain live independently of
inherited membership. Message rows outside membership can stay cached for other
conversations; they must not become inherited content merely by sharing a
presentation parent key.

Regression coverage lives in `tests/inbox-thread-history.test.js`, with real
Dexie hydration, database reopen, 3-of-5 inheritance, later parent replies,
nested branches selected from inherited and own messages, and legacy broad
membership whose boundary falls outside the visible tail. UI selection and
request-boundary coverage live in `tests/chat-message-manager.test.js` and
`tests/pg-write-adapter.test.js`.

When inspecting a production report, distinguish client membership from Tower's
stored lineage and effective transcript. These defensive client checks do not
establish that an uninspected Tower transcript or another client's transcript is
correct. A missing boundary in a partial page remains a separate pagination
condition; the clamp can apply once ordered membership includes that boundary.
