# Nstack hosting onboarding and draft legal pages

The first Tower connection screen offers Host My Tower on the left and BYO
Tower on the right, stacking below 700px. BYO retains known-host selection,
URL/descriptor input and the existing Connect submit handler.

Other Stuff’s proposed Nstack offer is USD $5 per GB per month, with a USD $5
credit against the first month’s 1 GB and an unpaid-account pause. The new
hosting button explains that subscription signup awaits activation. It does
not submit the existing hosted-free contract, provision a Tower, collect
payment or store pretend billing state.

The existing contract in `src/hosted-workspace-signup.js` and
`server/hosted-signup.js` uses `hosted-free-v1`, `hosted_free`, `free_allowance`
and `payment_required: false`. A reviewed server-authoritative contract for
Nstack subscription provisioning, billing, credit, payment and pause/resume is
required before activating the new hosting action. That change belongs with
the backend/service owners; the browser must not infer billing authority.

## Editing the policies

Edit `src/hosting-legal-content.json` for both policies and their shared draft
notice. Titles and paragraphs are rendered as text, not HTML. The standalone
Vite entries `legal/privacy.html` and `legal/terms.html` load no Alpine store,
workspace, signer or login. They are served as built HTML under the configured
Vite deployment base. Onboarding uses `%BASE_URL%` links with `target=_blank`
and `rel=noopener` to retain the open wizard and its draft.

Keep the draft indicator until the entity, working contacts, effective date,
metering/payment, cancellation/export, retention/backups, actual subprocessors,
hosting locations/transfers and applicable legal arrangements have been
confirmed. Draft fields deliberately provide no fictional contact links or
retention promises. The legal renderer is `src/hosting-legal-page.js`; styles
are `src/hosting-legal.css`. Rebuild after editing content.

Original draft prose was informed by the task requirements and the
[Supabase shared responsibility model](https://supabase.com/docs/guides/deployment/shared-responsibility-model),
[terms](https://supabase.com/terms), [acceptable use policy](https://supabase.com/aup)
and [U.S. Copyright Office section 512 resources](https://www.copyright.gov/512/).
Other Stuff does not adopt Supabase’s infrastructure claims or legal identity.
The draft preserves provider duties and does not assert automatic safe-harbor
immunity, a registered DMCA agent or that monitoring destroys safe harbor.

Browser storage wording reflects Dexie records/pending writes, device/sign-in
settings, temporary session recovery and application asset caches. No deployment
cookie/telemetry audit is claimed. Verify deployed middleware and integrations
before adopting a final privacy policy.
