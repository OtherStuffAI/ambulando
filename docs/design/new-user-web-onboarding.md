# New-user web onboarding

The web journey creates one identity-owned workspace on public nStack, purchases
one cloud agent through Stripe-hosted Checkout, and connects it with an
owner-signed policy. Existing workspace users keep their normal entry paths.
Native clients and their protocols are unchanged.

## Authority and recovery

The server stores one journey per owner in a persistent SQLite database before
creating a workspace. Its hosted-signup idempotency key survives reloads and lost
responses. Names can be corrected before the first workspace request; after an
uncertain workspace request they remain bound to that request. Tower's existing
site-attested hosted signup owns workspace creation.

Stripe's configured active one-time Price is the only source of offer amount,
currency and product. Initial support is exactly 21.00 in USD, AUD, EUR, GBP,
CAD or NZD; other amounts, currencies, recurring prices, inactive products and
mode mismatches disable Checkout. A bounded cached read of public Tower's OpenAPI must advertise canonical General support before Checkout; an older public backend also disables payment. Recurring billing requires a separately
implemented subscription lifecycle. No simulated payment or hosting-credit
purchase is substituted. The agent purchase includes one agent; it grants no
usage credit. Cloud usage and Tower hosting remain separate services.

Orders retain the Stripe merchant account, Price/product snapshot and each
Checkout attempt. Each attempt uses stable request bytes and a stable Stripe
idempotency key. An uncertain create request older than 23 hours needs operator
reconciliation because Stripe may prune its idempotency record after 24 hours.
Cancel/reload reopens the original live session; only canonical expiry or a
verified terminal asynchronous failure permits another attempt. A paid order
always resumes setup. Browser return parameters never confirm payment.

The raw-body webhook verifies Stripe's signature, timestamp, environment, then
retrieves the session with the configured merchant key. It verifies owner,
purchase, workspace, product/Price, quantity, currency, exact amount, payment
state and absence of discounts/tax/shipping. Paid state and a durable fulfillment
outbox commit before acknowledgement. Startup and bounded background recovery
resume unfinished paid provisioning. Database leases and cloud/signer stable
purchase keys protect concurrent and lost-response retries. Payment remains
monotonic when older failure events arrive.

wmcloud receives a dedicated HMAC-authenticated server request, never a browser
paid flag. Its signer holds agent private keys. The service returns a public npub
only after provisioning. The browser then uses existing Tower typed commands to
add membership, ensure canonical General, and reuse the exact private owner–agent
DM. General grants the Workspace group access, covering current and future
members without widening command authority.

The owner signs the existing wmcloud connection policy: owner-only commands,
no approved group commands, tools or public web. Fresh owner signatures for fixed
Tower and wmcloud routes let the server independently verify General policy,
owner membership, exact DM pair, enabled restricted connection and actual bot
visibility of both channels. Only these results mark completion. Workspace
collections materialize through TowerSyncService into Dexie; the onboarding
panel itself holds transient command status, not a second workspace database.

## Operator configuration

Use the ignored checkout-root `.env.local` for local managed runtime, or inject
server environment variables in production. The server explicitly resolves that
file relative to its source, independent of the runner's cwd. Existing process
environment takes precedence. Never prefix these settings with `VITE_`.

```dotenv
STRIPE_SECRET_KEY=<server-side Stripe secret or restricted key>
STRIPE_AGENT_PRICE_ID=<authorized active one-time 21.00 Price ID>
STRIPE_WEBHOOK_SECRET=<endpoint signing secret>
AMBULANDO_PUBLIC_ORIGIN=https://<public-ambulando-host>
AMBULANDO_ONBOARDING_DB=/absolute/persistent/private/orders.sqlite
WMCLOUD_ONBOARDING_URL=https://<approved-wmcloud-host>
WMCLOUD_ONBOARDING_SECRET_FILE=/absolute/private/fulfillment.secret
FLIGHT_DECK_TOWER_PUBLIC_BASE_URL=https://nstack.otherstuff.ai/
# Existing hosted signup broker settings must also be configured:
FLIGHT_DECK_SITE_CREDENTIAL_FILE=/absolute/private/site-credential
FLIGHT_DECK_SITE_BROKER_URL=<existing managed broker URL>
```

The shared fulfillment file must be mode 0600, contain at least 32 random raw
bytes, and match wmcloud's `WMCLOUD_AMBULANDO_FULFILLMENT_SECRET_FILE` byte for
byte. No newline trimming occurs. Configure wmcloud's fixed
`WMCLOUD_AMBULANDO_NSTACK_ORIGIN=https://nstack.otherstuff.ai` and its existing
Ambulando app npub. Its signer and runtime must permit that origin. Inline
`WMCLOUD_ONBOARDING_SECRET` is supported for environment-managed deployments;
prefer the private file. Do not put credentials into source, screenshots or logs.

Configure a Stripe webhook at:

```text
https://<public-ambulando-host>/api/agent-onboarding/stripe/webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

Register the correct sandbox/live endpoint and use its signing secret. Configure
merchant support/refund handling before enabling real purchases. Refunds and
disputes require operator reconciliation; this implementation does not delete
workspaces, keys or memberships or refund automatically. There is no subscription
cancellation promise because recurring Prices are refused.

`GET /api/agent-onboarding/config` publishes only nonsecret readiness and offer
information. Missing or unsupported configuration fails closed. Operator error
codes distinguish payment, cloud and workspace readiness; the user sees a short
availability message and can use an existing workspace/server.

Activate the managed Ambulando app after source validation. Cloud/Tower/signer
activation belongs to their operators. Preserve and back up the private database,
including SQLite WAL state using a consistent SQLite backup procedure. Never
clear receipts to retry a payment. Investigate an uncertain order with its
reference and canonical Stripe/cloud receipts before repairing state.

## Validation boundary

Focused tests inject controlled Stripe/cloud/Tower transport while exercising
real signatures, SQLite transactions, payment validation and orchestration.
Browser fixtures must block external requests; they do not prove a live payment,
public tenant write or running agent response. Read-only Stripe Price checks
must be reported separately from these controlled tests. No agent should complete
a live purchase to smoke-test this flow.

Source references: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment),
[webhook signatures](https://docs.stripe.com/events/manage-webhook-endpoints),
and [idempotency retention](https://docs.stripe.com/api/idempotent_requests).
