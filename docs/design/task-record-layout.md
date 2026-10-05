# Task record reading and editing

Task descriptions grow with their content. On desktop, the left task pane owns
scrolling and comments retain an independent, wider pane. On mobile, the task
body owns scrolling and the existing Task / Comments tabs select the visible
surface. Neither the description preview nor its contenteditable editor has a
line cap or a separate scroll window.

The shared composer autosizer exempts `task-description` from chat line limits.
Keep that exemption when changing composer sizing. Chat and comment composers
retain their sizing and resize behavior. Description mention hydration, paste,
Markdown, draft/save handling and edit leases retain their existing paths.

Status and assignee controls share a compact desktop row and wrap on mobile.
Description/editor and subtask container borders are removed; dependencies and
subtasks remain below the complete description. Scope data remains part of the
record and routing, without a scope field on this surface.

`tests/e2e/task-record-layout.spec.cjs` uses the built application with intercepted
local requests, without starting a server. Its long PG edit/read cases cover
1280, 390 and 320px, natural description height, actual wheel scroll ownership,
header/control fit, paste, mentions, heading rendering, mobile tabs and overflow.
The comments and title browser specs cover resize/fullscreen controls and long
title wrapping. These fixtures complement the task save, assignment, dependency,
comment ordering, offline and edit-lease unit tests; they do not establish live
Tower authorization or cross-client delivery.
