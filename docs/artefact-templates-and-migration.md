# Controlled artefact templates and latest-version migration

Ambulando creates channel-owned Docs and private Files. Canvases can arrange
references but are not required for a whiteboard. NStack owns records, immutable
revisions, private storage and authority. The template registry is maintained in
source; it is not another catalogue or database.

## Starters and styles

The Docs/Artefacts toolbar offers a controlled starter and style picker. Rich
Docs use the existing rich editor; whiteboards use Excalidraw; interactive HTML
uses the existing private sandbox and source editor. `src/artefact-templates.js`
provides blank/working-brief Docs, whiteboards, an interactive explorer and a
System Flow starter. Styles are versioned palettes shared by these starters.
Rich Docs inherit the existing reader/editor style; a palette is not embedded in
prose. Whiteboards persist their background. HTML embeds the selected CSS.

`metadata.artefact` on Files identifies `schema_version`, `type`,
`format_version`, `editor_id`, and optionally `template_id`, `template_version`,
`style_id`, `style_version`. Existing Files without a descriptor retain legacy
MIME/name detection. Unknown descriptor versions/editors fail closed. Templates
supply initial content only; changing a template never rewrites saved user work.

Future approved plugins must have an Ambulando-reviewed stable type/editor ID,
format version, bounded source validator, source-preserving read/write adapter,
asset and ACL rules, migration/rollback behavior and host compatibility tests.
No remote installation, arbitrary editor URL or runtime registry mutation is
supported. Adding an ID here alone does not grant a capability or backend access.

## System Flow

The bounded web editor stores a File with content type
`application/vnd.ambulando.system-flow+json` and descriptor type `system-flow`,
editor `builtin.system-flow`, format version 1. The JSON remains the legacy
`flow.json` schema (schemaVersion 1, 2 or 3). Schema 3 must include its complete
`scenes` map, hydrated from legacy scene files. Diagrams, IDs, parent containers,
positions, node kinds/owners/descriptions, detail-flow/whiteboard relationships,
edges and images survive typed edits. No screenshot or generated HTML replaces
the editable source.

The web editor supports diagram selection, node fields/position, edge labels and
endpoints, and validated JSON edits for adding/removing nodes and relationships.
Linked whiteboard scenes are preserved but not edited here. Scene/whiteboard
replacement is rejected; use the original legacy editor for those changes.
The simplified SVG overview does not reproduce every legacy handle/routing style;
source values remain intact. Feedback threads and legacy sharing/unlock codes
remain at the original URL. Native flow editing is not delivered by this change.

Saves use the captured File `base_version_id`; stale saves retain the local draft.
History is read-only. Access denial clears the view and draft using the existing
Artefacts lifecycle. A failed/unconfirmed save must be checked in version history
before retrying. Restoring a historical source should be an explicit reviewed new
revision, never a rewritten historical record.

## Import one selected latest version

Read the legacy source index/catalogue, saved source, assets and current access
rules first. Resolve the latest meaningful saved version; file timestamps alone
can disagree with numbered lineage. Drafts are separate from published versions.
Read/render the original when arrangement matters. Choose the destination from
source context and compare *all* effective readers, including explicit channel
grants, inherited groups and administrators. A private label is not an ACL.
Never broaden access to make a pilot easier. If destination authority is unclear,
continue other work and ask the manager. Keep existing grants unchanged.

```sh
bun scripts/migrate-artefact.mjs --folder '<selected-version-folder>' \
  --type system-flow --source-url '<canonical-version-url>' \
  --source-version '<version>' --title '<original title>' --dry-run

bun scripts/migrate-artefact.mjs --folder '<selected-version-folder>' \
  --type system-flow --source-url '<canonical-version-url>' \
  --source-version '<version>' --title '<original title>' \
  --tower '<tower-origin>' --workspace '<workspace-id>' --channel '<channel-id>' \
  --audience-verified --receipt '<ignored-new-receipt-path>'
```

Types: `system-flow`, `excalidraw`, `html`. The importer uses the capability
broker, existing private storage and channel Files. It saves an exact source
archive as a private sibling File, with per-file hashes, then creates the editable
primary File and private HTML image Files. The archive retains source bytes even
when canonical board rendering omits viewer-local state or HTML packaging inlines
styles/scripts. Unsupported content, unsafe paths, absent scene files or HTML
packaging warnings stop the import. A separately reviewed
`--legacy-navigation-reviewed` option permits only the known history/external-link
limitations: the host displays the original link and the saved provenance records
the limitation. It does not enable remote iframe networking or navigation. No legacy app directory is copied into the
product. Source exports and receipts belong only in verified ignored evidence.

Provenance lives on NStack File metadata: canonical source URL, source version,
source-manifest SHA-256, original-source File/version and `latest-selected-only`
history policy. A repeated source URL/version reuses the existing mapping after
readback; changed bytes or duplicate mappings require review. The immutable first
revision is compared to imported bytes even after subsequent user edits. Original
history is not fabricated. Original URLs, drafts, comments, assets and older
versions stay accessible in the legacy archive; no redirects or retirement.

Source/asset/primary writes are separate operations. On interruption, list the
complete destination Files and reconcile provenance before retrying. This helper
is sequential, not a transaction or a server-enforced uniqueness constraint: do
not run competing imports of the same source. Full/truncated discovery fails
closed. Keep successful partial Files; never delete them as retry cleanup.

After importing, read back exact versions and hashes, render original/imported,
exercise typed edit/save/reopen, asset loading and read-only/denied behavior.
Test rollback by appending a new revision containing the initial imported bytes.
Distinguish synthetic protocol tests, real API writes, real browser saves and
native/device checks. Source validation is not activation or release delivery.
