# Tower Blossom links

Existing `getStorageObject`, `getStorageDownloadUrl` and `completeStorageObject`
responses now preserve Tower's additive `blossom_url` and `blossom_auth` fields.
Use the returned URL: a legacy `sha256_hex` alone is not proof of byte verification.
Null URLs mean incomplete, missing, deleted-reference or unverifiable storage.

`blossom_auth: public` permits anonymous retrieval. `nostr` requires a signed
request and existing object or PG resource read permissions; a copied link does
not confer access. Existing browser downloads continue to use authenticated
`content_url` and preserve decryption behavior. The hash addresses stored bytes,
including ciphertext for encrypted attachments. No materialization or sync
schema change is required, and the browser must not silently replace signed
private downloads with an unauthenticated `<img>`/navigation link.

Tower implements root GET/HEAD retrieval, optional extensions, ranges and BUD-11
`get` authorization, and also accepts existing NIP-98 signatures on the exact hash
URL. Upload/management remain on Tower's existing APIs. No Blossom upload/list/
delete endpoints or automatic relay publishing are advertised. See Tower's
`docs/contract/blossom-storage.md` for verification and backfill operations.

## Explicit publication dialog

The Files and chat attachment actions read publication status from the selected
workspace's Tower. “Not published” means the selected bytes have no eligible
public publication; it is not a server capability claim. `can_publish` controls
write actions independently of public status. The dialog preserves API failures
and never treats failed status retrieval or cached rows as publication authority.

Publishing requires explicit confirmation. Files select a specific version;
chat attachments pin consent to the source link and verified hash. Mutation
results materialize through the command port into Dexie. The public link and
copy action use the returned URL only when the selected bytes report public.
Removing your reference cannot recall external copies or other publications.

The dialog supports desktop/mobile spacing, loading and mutation feedback,
Escape/backdrop dismissal, focus restoration and keyboard focus containment.
Browser tests use production API, signing, command and Dexie paths with stubbed
Tower responses; they do not attest deployment availability or a user's live
write permission. On an older Tower, a missing attachment route can return 404;
verify its deployed API before diagnosing a missing source attachment.
