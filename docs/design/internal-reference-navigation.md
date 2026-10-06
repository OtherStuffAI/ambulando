# Internal reference navigation

Internal references use one guarded destination dispatcher instead of requiring
the target to appear in the current rendered collection. A click first checks
the current workspace's local materialization, then loads a missing target
through its authorized Tower read. The source surface shows loading and errors.
Cached opening does not wait for remote reconciliation or an edit lease.

## Destinations

| Reference | Destination | Missing-target read |
| --- | --- | --- |
| `doc`, `document` and document aliases | Document detail | Single document/body sync |
| Document reference to a materialized file, or `file` | Existing file preview | Single file metadata read |
| `task` and task aliases | Task detail | Single task sync |
| `chat`, `message`, `thread` and message aliases | Conversation, preserving the Inbox modal when applicable | Canonical thread metadata, then authorized single-message lookup on thread 404 |
| `channel` | Channel conversation | Single channel metadata read |
| `scope` | Scope settings, focused on the target | Authorized scopes list |
| `directory` | Existing Docs folder | Local directory cache; no PG directory target route |
| `person`, `agent` | Identity card | Existing background profile resolver |
| Disabled report, flow, approval and schedule surfaces | Visible explanation | No attempt to enable the surface |

Docs directories and PG Files folders are different record families and UI
destinations. A `directory` reference must not be silently reinterpreted as a
Files folder. An unavailable legacy directory produces a contextual error;
automatic cold resolution requires a separately supported target contract.

## Visit and draft ownership

`internal-reference-navigation.js` captures the workspace authority and source
visit. The latest activation owns navigation; a changed workspace, section,
channel, detail visit or folder invalidates earlier reads. A response cannot
apply foreign workspace records or select a target after that visit expires.
Target metadata appended to channel/scope collections does not choose a default
channel or close the source conversation.

Before departure, dirty document/task drafts reach local storage. Existing
document and task lifecycle methods retain edit lease ownership and release
leases through their normal safe paths. Source comment composer text and audio
attachments are remembered per workspace, actor, type and target, then restored
when returning during the same browser session. These snapshots are not a
replacement for persisted document/task edit drafts.

Destination routes retain the source route for Back. Conversation composer
drafts remain owned by their channel/thread. The existing linked-thread resolver
continues to own conversation selection and history; the shared dispatcher
supplies cancellation and source-departure hooks. Channel context changes preserve the intended detail destination; deferred channel reads cannot close a newer document/task visit.

A cold message read uses `GET messages/:messageId` only after canonical thread lookup returns 404. Its workspace, requested message, channel and owning thread must agree before materialization. Denied canonical reads do not trigger a routing fallback. A threadless message opens its channel and focuses the message; source/reply IDs open their owning canonical thread. The client does not use workspace bootstrap as a link fallback.

## Click surfaces

Markdown pills, task reference chips, task/document comments, rich document
mentions and same-origin document/task/thread/channel/folder/scope/report URLs reuse the dispatcher. Document
blocks allow reference clicks to reach delegation before starting block edit.
Rich mention spans expose matching metadata and keyboard activation. Wiki node
views retain their primary-click, touch and text-selection behavior; stored wiki
IDs can resolve from Dexie or the narrow document read even when their page is
absent from the rendered wiki list.

Context-tree references retain their ACL recheck before ordinary destination
navigation. Files use a single file read and the existing download path, rather
than loading every document in the workspace.

## Verification seams

Focused tests cover target resolution, workspace authority, cancelled visits,
deleted/unreadable targets, source drafts and the existing thread resolver.
Native browser coverage exercises rendered links from the conversation modal,
task activity and document comments/blocks, including Dexie-only and cold
targets. Synthetic browser records establish UI behavior; they do not establish
authenticated access to a user's Tower records. Keep the wiki native first-click
suite and performance baseline alongside general reference coverage.
