# Channel creation and recovery

Named channel creation uses explicit Tower-supported person/group grants. The creator always retains Manage in the
creation form: a stale self row cannot replace Tower's creator recovery bundle with View or Contribute. Other access
rows remain deliberate choices. Creating a channel never repairs another channel's audience or infers group membership.

Tower's creator bundle includes the legacy `channel.grant` alias alongside standard Manage permissions. The access
editor recognizes exactly that bundle as Manage. Saving unchanged Manage preserves the alias; explicitly selecting
View or Contribute submits the selected standard bundle, removing management rights. Unknown custom bundles remain
protected from preset editing and bulk replacement. Custom scope defaults retain their exact concrete permissions
when copied into a creation draft; removing one and adding a different row is an explicit choice.

Scope defaults are draft suggestions, not authority over existing channels. They can be displayed alongside direct
channel grants, with direct channel rows overriding matching default rows, but they never enable channel management
controls. Scope/context roles remain separate from channel participation. Tower decides every read and mutation.

Web regression coverage includes creator recognition, unchanged roundtrip versus explicit downgrade, creator recovery
at creation, custom default preservation, direct overrides and denied management from a scope default. Browser fixtures
use intercepted local Tower requests; live release evidence belongs on the task. Native iPhone/Mac uses the same
existing API with its own SQLite renderer; its channel access behavior is documented in that repository.

## Moving a channel between scopes

Channel settings in the PG web client offers **Move to scope** for managed,
ordinary channels. Eligible destinations come from the materialized scopes and
exclude the current scope, special/archived scopes and scopes the viewer cannot
manage. This list is a convenience; Tower authorizes the channel, both scopes
and access-preview disclosure on every request.

`channel.move-preview` and `channel.move` use TowerSyncService's command port.
Preview sends `destination_scope_id`; confirmation sends the returned token and
a fresh UUID `mutation_id`. No scope is optimistically changed. Destination
changes invalidate the preview. An uncertain network failure retains the exact
request for **Retry same move**; 403/404/409 require a fresh preview. Tower's
warnings, actor permission summaries, source/destination scope context and
preserved direct-grant count are shown before confirmation. Scope grants are
not treated as inherited channel-content authority.

The command materializer commits the canonical channel and all loaded
channel-bound scope projections together in the original workspace database,
including pending drafts, hydrated document bodies, comments, files, audio and daily notes, raw journal
rows and attention projections. It updates scope indexes without changing IDs,
content or pending write envelopes. Only relevant scope/channel-indexed tables,
parent-linked projections, audio/daily notes, notification routes and canonical record rows are scanned, and unchanged channel locations
do not trigger a cascade. A newer channel timestamp protects against delayed
historical acknowledgements. Existing Dexie liveQuery subscriptions publish the
result to Alpine; the UI never copies the response into authoritative arrays.

`channel.moved` SSE hints bypass the ordinary recovery throttle and request
canonical journal recovery. Channel deltas perform the same cascade inside the
page transaction; ordinary reconnect cursor recovery therefore repairs loaded
children even before their individual deltas arrive. Tower remains responsible
for persistent relocation, exact retries, concurrency, permissions and links.

Regression coverage includes a failed transaction, loaded pending children,
unrelated channels, canonical reconnect deltas, deferred acknowledgement and
exact mutation retry. Desktop and narrow-screen browser fixtures intercept
local Tower requests and exercise preview, confirmation and a lost first
response without modifying a live workspace.
