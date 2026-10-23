# Chat mention hydration

The workspace member directory in Dexie is the authority for selectable PG
person and agent identities. Actor sidecars resolve record attribution; they
must not substitute for workspace membership. Channel visibility still comes
from the existing participant, group and grant rules.

Load cached members before local channel selection can open a composer. Keep
the workspace member subscription active independently of remote directory
requests. A failed or explicitly incomplete directory read cannot replace the
downloaded roster with a self-only fallback. A successful complete directory
read still replaces eligibility, including removal of retired identities.

PG subscription queriers must begin their Dexie reads without first awaiting
a foreign promise such as a dynamic import. That await can lose Dexie's
observation context: the initial read succeeds, but later local writes no
longer deliver updates. Keep cursor-key imports outside the querier, including
the navigation projection querier. The subscription lifecycle continues to
fence deliveries by workspace key and selection generation.

The authoritative shell lifecycle installs a local reactive effect for the
open mention picker. It observes replacements of eligibility and label inputs,
coalesces recomputation into a microtask, and reads the current composer and
channel when recomputing. Closed pickers do not scan history or initiate reads.
The people cache includes workspace metadata and scopes alongside roster,
groups, channel grants and profile inputs. Typing continues to reuse cached
people between source changes.

Regression coverage lives in `section-live-queries.test.js` for actual Dexie
updates and stale delivery, `workspace-manager.test.js` for warm bootstrap,
`channels-manager.test.js` for failed/incomplete reads and authoritative removal,
and `mention-channel.test.js` for local picker updates and isolation.
`e2e/membership-mentions.spec.cjs` exercises the rendered production picker and
canonical structured agent insertion using synthetic local data with network
requests unavailable. It is distinct from authenticated live verification.
