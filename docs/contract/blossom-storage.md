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
