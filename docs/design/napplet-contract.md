# Ambulando napplet contract — agreed 23 November 2026

Status: agreed product contract; not a claim that collection storage or all capabilities are implemented. Supersedes earlier separate-napplet-workspace proposals and mandatory re-consent on every code update.

## Experience
Ambulando is the console; napplets are cartridges. Phone, desktop and browser carry a common runtime. A user asks their bot for a function; the bot publishes its bundle in NStack and adds it directly to the current workspace's Apps, initially visible only to the requesting user. The user tries it and chooses when to share. Routine publication and updates require no Ambulando build, reinstall or separate hosted service. A new underlying runtime capability may require a host update.

## Ownership and namespace
Use the existing current NStack workspace. Within it, distinguish Ambulando's application namespace, its own records, and each napplet's namespace. Do not create another workspace per napplet. NStack remains the system of record and storage owner; no replacement catalogue/database. Namespaces organise data and are not authorization.
Each napplet has stable identity independent of bundle version and display name. One installation per napplet per workspace; no multi-instance installation feature. Variations use separately named napplets with distinct identities or separate datasets.

## Collections
Expose named collections of individual JSON records through a reusable contract. Collections may be personal or team-shared, with explicit ownership and access. Personal means restricted to the owner and explicitly granted identities, not implicitly readable by every workspace member. Bind operations to workspace, application, napplet and current identity. Support bounded/paginated queries, record identity, revision-aware updates, explicit deletion, schema versions and data migration. Updating bundle code preserves data and history. Existing File-backed data must be preserved with a deliberate migration path; do not silently recast it as completed collection storage.

## Audience and authorization
Workspace App managers can add/share napplets within their own authority. Audience may include one or more user or agent npubs. Discovery/open permission, data read/write permission and personal host capabilities are distinct. All NStack operations enforce server-side permissions. Napplet access cannot exceed the acting identity's grants; sharing the UI does not share private records.
Agents act as themselves with explicit delegation. No automatic user impersonation or approval of expanded access.

## Updates and lifecycle
Updates load automatically without reinstalling. Ordinary code/UI/logic changes within approved access do not prompt again merely because code bytes changed. Authenticate authorized publishers and validate bundle revisions/integrity.
Notify and request approval for expanded capabilities or resource access; do not silently grant it. Declining keeps existing permitted functionality where compatible, otherwise give a clear compatibility explanation. Keep prior bundle versions for rollback; data migrations must explicitly account for compatibility and destructive changes.
Removal offers Remove and keep data and Remove and delete data. Explain deletion scope, require confirmation, and enforce authority; reinstalling can reconnect retained data.
First version is online-only. Offline editing, background execution and a marketplace are outside this first contract.

## Identity and Nostr capabilities
Ambulando owns the authenticated host bridge and signer integration. Never provide raw private keys, signer credentials or unrestricted signing/decryption to napplet code. Capability access is scoped to the logged-in identity and active workspace, re-evaluated on revocation or context switch, and previous private context is cleared.
A Nostr DM feed is a capability example: approved relay retrieval and supported signer decryption under explicit personal permission. Read/decrypt, send, persist plaintext and agent access are separate grants. Unsupported signer operations must be reported honestly. This contract does not claim DM capability is currently implemented.

## Common runtime contract and release acceptance
Manifest declares stable napplet identity, version, runtime compatibility, collections and requested capabilities. Use one protocol across web, iPhone and Mac; Android follows the same contract and can catch up later.
Prove two arbitrary napplets absent from host source can be published after the host build; update one without changing host assets/binary and retain its data. Verify workspace and identity isolation, personal/team grants, user/agent audience, expanded-permission denial/revocation, removal choices and existing-data preservation.
Track exact delivered build numbers and separate local tests, live checks and device installation evidence.

Source: originating napplet design thread, particularly the product owner’s decisions on 23 November 2026 and request to update this contract.

## Related implementation references

This is the canonical agreed product contract in this repository. The authoritative
[Ambulando common napplet contract](mention:document:8f933fd4-744b-4a0c-ab03-5369f1dff1cc)
is its source. Changes to implementation references do not imply this contract is delivered.

- [Common runtime v3](napplet-runtime-v3.md) specifies the additive implementation and current limits.
- [Generic File protocol v2](generic-napplet-v2.md) documents the existing wire format and receipt policy.
- [File authoring](../generic-napplet-authoring.md) documents current publishing and opening steps.
- [File data bridge](file-napplet-data.md) documents the existing tracker and preservation constraints.
- [Organisation data](org-data-napplets.md) documents a separate typed-data capability; it is not proof of arbitrary personal collections.
- [Implementation gaps](napplet-contract-gaps.md) distinguishes current evidence from required work.
