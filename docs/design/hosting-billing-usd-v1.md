# Hosted USD billing view

Tower owns the customer account, tariff and financial ledger. The Tower Usage
surface displays its USD hosting status alongside covered storage measurements.
After verified hosted signup and workspace selection, the same view opens so the
creation → linked account → balance path is visible.

The registered `hosting-billing` TowerSyncService read family fetches signed status,
usage and ledger endpoints, validates workspace/account binding, and materializes
a single atomic `hosting_billing` Dexie row. Its partition includes workspace,
Tower, app, endpoint and viewer. liveQuery drives Alpine rendering; closed views
unsubscribe and workspace switches reject late network responses. Visible views
refresh through the existing fallback sync lifecycle and explicit refresh action.

Stripe Checkout is an explicit signed command via the existing API/transport
adapter, independent of data materialization. Return URLs must be allowlisted on
Tower. Redirects never grant money. Only a verified Tower webhook changes balance;
refreshing the billing projection reads the resulting ledger. No Stripe secrets
are accepted or stored in browser config.

New signup uses `hosted-usd-v1` terms: $5 per decimal GB per 720 hours, once-only
$5 customer promotion expiring in 30 days, and shared workspace funding. Old free
signup clients must update with Tower. Existing workspace status is unlinked and
shows that no USD enrollment occurred. Unsupported/erroring Towers display the
request failure instead of a fabricated balance or successful payment.

The first pass supports test Checkout only. Managed signup requires an authorized
server-side site signer, allowlisted site on Tower and explicit hosted Tower URL.
`signup_ready:false` is an activation blocker, not a reason to create credentials
or silently bind the UI to another Tower.
