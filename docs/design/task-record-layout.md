# Task record reading and editing

Task descriptions grow with their content. On desktop, the left task pane owns
scrolling and comments retain an independent, wider pane. On mobile, the task
body owns scrolling and the existing Task / Comments tabs select the visible
surface. Neither the description preview nor its contenteditable editor has a
line cap or a separate scroll window.

The description mounts the existing Tiptap adapter with task-specific routed
reference marks and a formatting toolbar. Markdown is parsed on load and plain
text paste, then serialized back to the existing description field on edits.
Canonical actor and record references retain their links across save/reopen.
Mention autocomplete inserts native editor marks rather than changing editor DOM.
Chat and comment composers retain their sizing and resize behavior; the shared
composer autosizer also exempts `task-description` from chat line limits.
Draft/save handling and edit leases retain their existing paths.

The title and actions share the top row, with Back immediately left of the title.
Narrow layouts keep Back beside the title and wrap the right-side actions below.
Status is a coloured button with a state picker (arrow keys, Home/End, Enter/Space and Escape). The assignment
control shows either avatar/name and Clear or a compact typeahead. Remote-update
notices live in the overflow menu; Save/Discard retain draft reconciliation.
Status and assignee controls share a compact desktop row and wrap on mobile.
`tests/e2e/task-back-control.spec.cjs` exercises the production header at
1280/390/320px in both themes: read/edit long titles, keyboard order, Save/reopen,
Discard, clipboard/menu focus, PG draft retention on Back and history return.
With `FLIGHTDECK_TASK_LIVE=1` it uses managed runtime assets while blocking
backend traffic; these fixtures do not establish authenticated Tower acceptance.
Description/editor and subtask container borders are removed; dependencies and
subtasks remain below the complete description. Scope data remains part of the
record and routing, without a scope field on this surface.

`tests/e2e/task-record-layout.spec.cjs` uses the built application with intercepted
local requests, without starting a server. Its long PG edit/read cases cover
1280, 390 and 320px, natural description height, actual wheel scroll ownership,
header/control fit, paste, mentions, heading rendering, mobile tabs and overflow.
The comments and title browser specs cover resize/fullscreen controls and long
title wrapping. These fixtures complement the task save, assignment, dependency,
comment ordering, offline and edit-lease unit tests.
`tests/app-task-rich-description.test.js` exercises a native editor edit through
the PG save path and reopens persisted Markdown with references intact. These
fixtures do not establish live Tower authorization or cross-client delivery.

Descriptions open as readable Markdown previews, including an empty-description
placeholder. Clicking ordinary text enters Tiptap and focuses the caret; the
Edit description button provides keyboard entry. Link/reference clicks and text
selection retain their reading/navigation behavior. Entry checks sign-in,
read-only, save/checkout progress and rejected/conflicted pending saves. View-mode
entry uses the existing task edit operation; PG retains local drafts with explicit
Save/Discard. Immediate typing during the lazy mount is retained, and focus-only
internal block-ID updates do not mark the description dirty.

The selected-task live materialization must preserve description editing state.
It previously reset populated descriptions to preview while PG hid the toggle,
leaving no edit entry. `tests/e2e/task-description-entry.spec.cjs` selects a local
workspace database, opens tasks through `openTaskDetail`, applies the selected-task
refresh and clicks/types without assigning edit flags. It covers empty/populated
entry, keyboard focus, links/selection, blocked states and mobile tabs at 320/390px.
The app editor tests exercise PG Save/reopen with persisted descriptions and
references. The browser spec can use served runtime assets with
`FLIGHTDECK_ENTRY_LIVE=1`; its seeded data and blocked transport do not establish
authenticated Tower authorization or cross-client delivery.

Scheduling and tags now stay in the compact heading in both read and edit modes.
The date chip opens the existing date-key calendar as a custom month popup;
arrows move by day/week, Home/End move to the week edges, Page Up/Down change
month, and Escape returns focus. Selected and today cues are independent.
Clear stores `null`; selection stores the existing date-only `YYYY-MM-DD` value.
There are no scheduling shortcuts or visible native date inputs on this detail.
Tag chips use the shared lowercase comma-delimited convention and deduplicate
on edits. Add tag searches loaded workspace vocabulary or creates a typed tag.
Both controls enter the existing edit path before mutating the draft and retain
Save/Discard. `tests/e2e/task-date-tags.spec.cjs` covers synthetic full-page/modal
interactions at 1280/390/320px, keyboard focus, selection/clearing, tags and
Save/reopen/Discard. Backend commands are stubbed; this is not authenticated
Tower acceptance.

The task board uses the same rounded status, tag and date treatment. Its status
filter is an in-app button picker with arrows, Home/End, Enter/Space and Escape.
`formatStateLabel` supplies Backlog for persisted `new` across the board, filters,
detail, dependencies and other task displays. Board grouping uses that shared
formatter; wire state values and task creation labels retain their meaning.
`tests/e2e/task-board-controls.spec.cjs` covers board/list/filter presentation and
keyboard interactions on desktop and mobile with blocked backend requests.
