# Deck file previews

Deck Inbox and Files cards open the storage attachment rather than its parent
record. Canonical Tower files remain materialized in the local document table,
but their `pg_record_type: file` identity, storage ID, MIME type and workspace
metadata select the file preview. Genuine internal documents keep the existing
document reader and comments route.

The shared image modal presents authenticated storage images and a filename
with Save locally. Other attachments present a file view with the same download
action. The existing signed blob API supplies both preview and download bytes;
file URLs are never used as internal document IDs. Checkout is future work.

Backend resolution uses explicit source metadata, then the current or uniquely
matching known workspace. Unknown or ambiguous noncurrent workspaces fail visibly
instead of fetching the object from the current backend. Close, Escape and
workspace changes invalidate pending preview loads and release owned blob URLs.
Composer draft URLs remain owned by their draft lifecycle. The dialog restores
focus to its trigger and keeps keyboard focus within its controls.

Coverage includes canonical image/PDF projection, genuine document routing,
backend lookup, download failures and late-load handling. The synthetic browser
pass exercises Deck card clicks, signed storage requests, image rendering,
filenames, downloads, errors, Escape and focus restoration on desktop and mobile.
It does not attest a private backend's ACLs or Pete's live workspace data.
