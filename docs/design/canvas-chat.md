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

## Verification

`tests/canvas-chat.test.js` checks placement/routing, bridge identity checks,
single-flight binding, uncertain-save recovery, duplicate reference keys,
removal and visibility lifecycle. The Canvas Playwright flow exercises the
ordinary composer and signed send path against a synthetic Tower, independent
conversations, structured mentions, Dexie updates and reload. Synthetic signing
evidence does not establish real Autopilot dispatch; that requires a separately
observed authorized live conversation and response.
