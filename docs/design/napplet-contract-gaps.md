# Common napplet contract: implementation gaps

Assessment against the [agreed product contract](napplet-contract.md), 23 November
2026. This is a planning assessment, not implementation or release acceptance.
No new wire schema, capability identifier or backend endpoint is specified here.

## Evidence and limits

The web source supports arbitrary v2 HTML Files with one bound capability:
`private-json-file@1` or read-only `workspace-aggregate@1`.
`src/napplets/generic-protocol.js` validates that manifest and includes the code
digest in approval fingerprints. `generic-apps.js` installs personal File pins,
reopens the same File on update checks, and unpins without deleting data.
`generic-data.js` and `generic-reads.js` implement File access and immutable-version
checks. The protocol and tests establish a reusable File bridge, not collection
storage. Organisation-data APIs are a separate typed-data implementation.

Prior task reports describe web build 2752, Swift Mac 107/iPhone 108 and Android
65 (0.9.37). These are historical reported baselines, not builds produced here.
Native reports cover arbitrary bundles and data retention using fixture transport;
separate browser/Kotlin API checks and Android store-install evidence were reported.
They do not prove product-owner device installation, personal/team collections or this
revised contract. Native and NStack source were not independently audited in this
bounded repository pass. Keep exact logs and operational details on the task.

## Prioritised work

| Priority | Owner | Required work and acceptance |
| --- | --- | --- |
| P0 | NStack | Define reusable named JSON collections under current workspace/application/napplet identity. Enforce personal owner/explicit grants and team grants server-side, bounded pagination, record IDs, revision updates, deletion, schema versions and migration. Existing org-data and private Files do not prove this contract. |
| P0 | NStack + clients | Define stable napplet identity and one installation per napplet/workspace, independent of bundle version/name and personal launcher pins. Add manager-authorised requester-only delivery and user/agent npub audiences. Separate discovery/open, data grants and personal capabilities; agents use explicit delegation as themselves. No separate napplet workspace or replacement database. |
| P0 | Web + Swift + Android | Replace code-digest re-consent as a product policy with authenticated publisher/integrity verification plus access-expansion approval. Preserve immutable revisions; ordinary code changes load automatically within grants. Denial retains compatible permitted functionality or explains incompatibility. Keep revocation/context teardown; do not remove digest integrity validation. |
| P0 | NStack + clients | Inventory existing File bindings/history and design deliberate migration with compatibility, rollback and destructive-change handling. Preserve IDs/data/history until migration is verified; never relabel whole-object File saves as collection CRUD. |
| P1 | Web + Swift + Android | Extend the common manifest to stable identity, bundle version, runtime compatibility, collection declarations and capabilities. Agree one protocol before implementation; existing exact-key v2 parsers cannot accept invented fields. Add common fixtures for supported/unsupported host versions. Android may follow later using the same contract. |
| P1 | NStack + clients | Provide Remove and keep data / Remove and delete data with explicit scope, confirmation and authority. Reinstall reconnects retained data. Existing unpin is only a preservation mechanism, not both removal choices. |
| P1 | Host/signers + clients | Design scoped personal capabilities without raw keys, credentials or unrestricted signing/decryption. DM retrieval/decryption, sending, plaintext persistence and agent access need separate grants, honest unsupported-signer errors and revocation/context clearing. No DM capability delivery is claimed. |
| P1 | All owners | Repeat acceptance on frozen hosts with two arbitrary post-build bundles, code update/data retention, personal/team isolation, user/agent audiences, denied expansion/revocation, both removal choices and existing-data migration. Separate local fixtures, live server checks and device-installed evidence by exact build. |

## Platform follow-through

Web changes belong in the existing worker/transport, local Dexie projection and
host bridge seams; render persisted collections from Dexie and keep heavy work
off the main thread. Preserve ordinary HTML's lack of bridge authority and the
documented web iframe self-navigation risk; changed consent policy does not make
untrusted code safe. Trusted publisher authorization needs explicit validation.

Swift must align iPhone and Mac bridges, consent storage, Apps audience/update
flow and migration with the shared contract. Android must align its host and
signer capability support with the same protocol, then validate the actual
installed artifact separately from JVM/API and synthetic UI tests. These are
follow-up owners, not instructions to edit or release adjacent repositories now.

The first contract is online-only. Existing local caches do not imply offline
editing support; background execution and marketplace work remain outside scope.
