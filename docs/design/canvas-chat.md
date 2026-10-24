# Canvas Chat naplets

Choose **Chat** in the Canvas toolbar and click the board to place a chat.
One scope tap opens its channels; one channel tap opens the ordinary thread
composer. Each naplet starts an independent conversation. Existing linked
`chat_thread` naplets use the same interactive presentation.

## Conversation and persistence

The first message goes through `sendDeckThread` and the normal PG chat write
adapter. It creates an ordinary scope/channel thread, accessible in Chat.
Replies use `sendThreadReply`. The normal composer owns paste, file/image/audio
attachments, mention completion, structured agent mentions and instruction
signatures. Canvas has no message store or agent-dispatch implementation.

Before sending, the naplet is a viewer-local draft and disappears on reload.
After Tower accepts the first message, a same-origin/source-checked bridge sends
only the thread id to Canvas. Canvas creates a normal `chat_thread` naplet with
the existing layout, resize, minimize and expand behavior. Removing that naplet
deletes only its Canvas reference, leaving the conversation intact.

Binding save and chat send are separate operations. A binding failure exposes a
retry that never sends another message. Recovery stores only the accepted thread
id, local naplet id and layout, partitioned by Canvas authority and viewer.
A fresh snapshot reconciles a possibly successful naplet POST before retrying.
Recovery is best effort when browser storage is unavailable; the accepted thread
still exists in normal Chat. Empty drafts require no Tower contract expansion.

## Embedded normal chat

A same-origin iframe hosts the existing app's thread modal with its surrounding
shell hidden. The embedded startup selects the exact saved workspace, checks the
saved signer identity, initializes ordinary signing, channel hydration, member
state and section live queries, and opens the existing thread APIs. It avoids
shell discovery and does not persist a global workspace/navigation selection.
Tower continues to authorize each signed channel, thread, message and attachment
request; a Canvas reference grants no chat access.

Each iframe has its own Alpine composer state and a naplet-specific draft key.
All use the same workspace Dexie database and ordinary reactive thread detail
queries. Replies arriving from another view appear through those subscriptions,
with normal scroll anchoring and focus preservation. The iframe also isolates
typing, pointer, wheel and paste events from Canvas pan/drag shortcuts.

An IntersectionObserver and page visibility messages suspend background sync,
live activity transport and activity ticks while an editor is offscreen,
minimized or in a hidden tab. Resuming uses the existing sync service. The iframe
and input DOM remain mounted, preserving selection and unsent input. Removing a
naplet destroys its browsing context and disconnects the visibility observer.
Embedded views do not register another service worker or version-check loop.
Visible naplets still carry separate app stores and workers; very large boards
with many simultaneously visible chats need further capacity measurement.

Canvas comments remain their existing independent feature.

## Parent browser signer

When the saved login uses a browser extension and the embedded document has no
signer, it installs the existing `setExtensionSignerBridge` before its first
Tower read. The ordinary auth code and background worker bridge chain through
the Canvas parent; the composer, NIP-98 request proofs, kind-33358 message
instructions and structured mentions keep their normal implementation. No
`window.nostr` shim or alternate chat send API is installed. PG chat needs no
NIP-44 operation, so encryption and secret-key operations are not exposed.

Only `canvas-chat-frame` registers a signing handler. Each request must match
that element's exact contentWindow, same origin, current trusted document URL,
naplet key, workspace and saved active extension identity. The handler checks
persisted credentials and the live public key before and after signing, and
checks context/provider/document continuity again inside the normal serialized
native signing queue. Workspace/session/provider changes revoke the binding;
reopening the chat is required. Late results are discarded. Initial iframe load
is allowed even if app initialization starts signing before `load`; subsequent
navigation, removal and parent pagehide revoke the connection. Input DOM and
ordinary composer draft persistence are not reset by signer failures.

The protocol supports only `getPublicKey` and `signEvent`. Signing accepts only
NIP-98 proofs for this Tower's exact workspace read routes, explicitly allowed
chat/attachment/sync/view-state write routes and ordinary storage completion or
download routes, or message instructions tagged for this workspace. It rejects
administration, unrelated APIs and event kinds. Tower retains record/channel
ACL authority. The signed event must preserve the request's public key, kind,
content and tags, carry a valid signature and a current timestamp (the normal
queue refreshes timestamps when signing begins). Only public event fields are
returned. The bridge cannot constrain payload contents from their NIP-98 hash;
it trusts the registered application document, not arbitrary artifact HTML.

Requests use unique correlated IDs and at most eight pending operations per
frame. Parent requests expire after 30 seconds; the child transport expires
after 32 seconds, with a 33-second auth bridge allowance. The ordinary native
signer's 10-second approval timeout is unchanged. Queue work checks expiry and
identity before opening a prompt, including persisted logout while queued.
Rejection, timeout and connection loss reach the existing composer error path.
First-send failures retain input; replies retain the existing failed-message row
and normal retry action. A prompt already shown by a browser extension cannot be
programmatically dismissed; its late result cannot complete a revoked request.
The worker's existing independent auth/SSE deadlines remain unchanged.

## Verification

`tests/canvas-chat.test.js` checks placement/routing, bridge identity checks,
single-flight binding, uncertain-save recovery, duplicate reference keys,
removal and visibility lifecycle. The Canvas Playwright flow exercises the
ordinary composer and signed send path against a synthetic Tower, independent
conversations, structured mentions, Dexie updates and reload. Synthetic signing
evidence does not establish real Autopilot dispatch; that requires a separately
observed authorized live conversation and response.

`tests/canvas-chat-signer.test.js` covers origin/source registration, URL and
operation constraints, identity/provider/document drift, stored logout, complete
signed-event integrity, first-load timing, navigation, bounded pending requests,
rejection, timeout and cleanup. Auth tests cover the queued pre-sign guard. The
Canvas browser flow additionally runs with a signer injected only into the
parent and extension credentials containing no secret. It verifies authenticated
reads, exact signed NIP-98 URL/method/payload proofs, kind-33358 signatures,
structured mentions, rejection with preserved input, independent chats and reload.
These fixtures use ephemeral test keys and synthetic Tower responses; they do
not establish physical Nostr Browser behavior or real Autopilot dispatch.

## Message origin and explicit references

Each embedded composer shows a clickable **From: Canvas name** chip before
sending. The ordinary send path serializes that visible chip as a canonical
Markdown link at the start of the message body. Every first message and reply
captures its own origin; the thread does not acquire an origin. Ordinary Chat
renders the saved link and composes new messages without inheriting it. Failed
send retries keep the original serialized body and signature path.

`@canvas` and `@canvas:` in chat composers offer This Canvas first when embedded,
then accessible named canvases and ready items on the current Canvas. The
`this` and `thiscanvas` aliases select the actual Canvas identity. Filtering
supports spaces. Selection creates an atomic clickable link chip whose canonical
Markdown survives ordinary draft storage, paste, message hydration and reload.
Unsent drafts retain the ordinary in-memory save/restore lifetime; this does not
add hard-reload draft recovery. Normal person/agent completion and structured
agent routing remain independent.

The parent frame sends only a small projection of its already-authorized Canvas:
workspace/Canvas IDs and title, ready item labels and source/version IDs. It
never sends HTML, document, scene or chat content through this bridge. Named
Canvas discovery uses the existing Tower-authorized list and Dexie projection;
async results are fenced by composer, query, request and workspace identity.
No artefact bulk read is added to sending. Losing the parent context blocks a
new embedded send; ordinary failed-message retry preserves the captured origin.

Links reuse `/canvas.html?workspaceid=…&canvasid=…&napletid=…`. Item links add
`sourceid` and, when available, `versionid`; opening verifies the naplet still
names that source and uses existing viewer-local HTML/board version browsing.
This neither pins the shared naplet nor changes access. Missing or denied
sources retain neutral unavailable handling.

Origin and explicit references are visible canonical links inside the exact
body signed by the existing kind-33358 instruction proof. They are client
assertions, not new authority. Tower still authorizes each record read. Existing
Autopilot body projection includes their readable labels and resolvable URLs in
agent prompts; unsigned metadata is not trusted as instruction provenance.
Canvas references never create structured agent mentions or dispatch work.

The browser suite retains an opt-in regression case for signer revocation while
this fixture also injects live history: the failed reply was observed as pending
in that combined UI path. Run with `CANVAS_REVOKED_HISTORY_REGRESSION=1` to
reproduce. The isolated revocation case verifies a false send result and the
same failed row in both Dexie and the UI. The combined observation remains
unclassified; it is not evidence of a completed general sync repair.

## Embedded work budget

Embedded frames keep the ordinary conversation/composer and task/document detail
code, but remove shell DOM branches before Alpine starts. They do not activate
Inbox, feeds, public notifications, personal WApps, pinned navigation or org-data
installation discovery. Their workspace subscriptions retain navigation/access
fences, groups, members and agent activity inputs; active detail subscriptions
still read canonical Dexie rows. This does not change the signer bridge,
kind-33358 body signing, attachment handling or durable command queue ownership.

A hidden frame unsubscribes its local queries and stops transport/activity ticks.
Resume recreates the required subscriptions and resumes the existing sync path
without replacing the editor or its draft/selection. An in-flight send retains
its normal completion/retry behavior. Ordinary Ambulando uses its existing query
plan; these gates require the embedded-frame flag.
