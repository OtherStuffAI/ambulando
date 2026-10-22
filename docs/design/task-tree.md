# Task Tree canvas naplet

Task Tree is a view of shared tasks, with parent relationships below a card and
directed successor relationships to its right. It stores no separate task data
or canvas-only dependencies. Removing or duplicating a naplet changes the view;
it does not delete or duplicate tasks.

Choose Task Tree from the canvas toolbar or Add naplet, then explicitly select a
scope and channel. This destination belongs to that naplet and is independent of
other conversations and naplets on the canvas. New Task creates a title-only
base task. Existing Task lists the selected channel's readable tasks with paging
and a name filter. Changing the destination resets root selection without moving
the prior tasks. Changing insertion point or destination asks before discarding
an unsaved title.

Every card opens the existing task details interface. Add child creates a task
with that card as parent; Add next task records that card as predecessor. A
successor keeps its predecessor's parent. Enter and the Add button retain the
insertion point for repeated siblings or parallel successors. Continue from new
task explicitly moves the insertion point to the last created task. Creation
does not add descriptions, assignment, scheduling or automatic dispatch.

## Authority and persistence

Tower admits the `task_tree` canvas source type with a channel UUID as its source
ID. The source projection contains the independently authorized channel and scope
identities, channel label and `can_create` permission. Root identity, collapsed
branches, explicitly requested upstream context, stable instance identity and
viewport live in `layout.task_tree`, using the existing naplet CAS mechanism.
The `tree_channel_id` PATCH authorizes the new destination and clears old root,
branch and viewport state. Denied naplets omit the Task Tree layout payload as
well as all source and content fields.

The shared task creation route accepts an optional `client_request_id`. Exact
actor/workspace/destination retries return the original task; conflicting reuse
returns 409. Task and relationship metadata are written together. The browser
captures and retries the same request after an uncertain result. It retains the
failed title and never treats an unconfirmed relationship as success.

Tower's canonical create/update routes validate related task access, duplicate
predecessors, self-links, parent cycles and dependency cycles. Relationship
updates use row versions. A workspace task advisory lock serializes graph
validation and mutation. Existing workflow states retain their ordinary meaning.

`GET /tasks/:taskId/relationships` pages through direct children and outgoing
successors. Every returned task is independently authorized. Hidden/deleted
relationships produce a generic unavailable flag. The client follows every page
with a visited set and retains an explicit frontier when bounded loading stops.
Upstream context is loaded only on request, without automatically traversing its
unrelated branches. Cross-channel cards show their authorized channel label.

## Browser ownership

`TaskTreeRuntime` is the standalone canvas's task network/materialization owner.
It writes shared task rows through the existing protected Dexie task writer and
subscribes through `liveQuery`. Local task-board/detail edits propagate through
that same table. One ten-second refresh subscription for the canvas discovers
remote task additions and access changes while the page is visible. It stages
membership before swapping a refreshed graph, retains previous placement and
preserves pending local edits. Authorization denial clears rendered cached
content. Removed/rebound views fence late responses and worker results.

Projection and deterministic collision-free placement run in a worker. A shared
successor is one card with all visible connectors. Initial loading/rendering is
bounded to 100 cards, and Load / show more advances the frontier in increments of
100. The graph projector caps an individual render at 2,000 cards. Loading and
partial/unavailable states remain explicit. At the 2,000-task bound, a visible
notice directs the user to Focus tree here on a card to explore its subtree. Invalid existing cycles cannot cause
recursive rendering or infinite traversal.

Fit, zoom, collapsed branches and internal scrolling retain view state. Fit
keeps cards at a readable minimum scale and uses internal scrolling when the
whole graph cannot fit at that size. Explicit zoom controls can go further. Buttons
and fields have keyboard operation and 44px touch targets; touch dragging the
graph background scrolls locally without panning the outer canvas. The outer
naplet's standard movement, resize and window controls remain available.

The task details dialog embeds the ordinary application/task editor through the
existing canvas frame lifecycle and signer bridge. Task command signing is
enabled only for registered task surfaces; workspace administration remains
excluded. No second task editor or task-saving implementation is introduced.

## Verification

Graph/runtime tests cover shared successors, cycles, progressive bounds, stable
positions, authority loss, protected local edits and late reads. The browser
fixture uses signed intercepted local Tower routes and canonical Dexie rows; it
covers repeated entry, chains, independent destinations, retry, reload,
collapse/expand, shared updates, normal detail editing and large graphs.
These simulations are distinct from authenticated deployed Tower acceptance.
Run the required general Playwright performance baseline in addition to the
feature-specific browser checks. Tower must be activated before reporting the
feature as operational end to end.
