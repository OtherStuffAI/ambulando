# Ambulando Sol frontend

Sol is the Flight Deck browser client presented with Ambulando design system v5.
The fork retains Alpine, Dexie materialization, Nostr signers, Tower adapters,
worker synchronization, checkout/edit leases and permissions. Its namespace and
record contracts are unchanged. Source commits remain local until a dedicated
Sol remote is configured; never publish to the original Flight Deck remote.

## Surface audit and presentation ownership

The audit identified root `index.html` as the connected product template, with
shared styling in `src/styles.css`, pipeline styling in `src/pipeline-viewer.css`
and shell state assembled from `app.js` and `shell-state.js`. These continue to
own their existing behavior. The presentation layer comprises exact v5 tokens in
`src/ambulando-tokens.css`, migrated shared semantic declarations, and component
conventions in `src/sol.css`. Avoid new fixed light colors in any product surface.

| Surface | Existing behavior retained | v5 presentation |
| --- | --- | --- |
| Shell/navigation | Section routing, view locks, scope/channel selection, workspace discovery/switching, profile/sync feedback | Confluence/name in expanded sidebar, symbol in rail, local Lucide navigation, responsive drawer, native keyboard buttons |
| Login/onboarding | Ephemeral, NIP-07, bunker/nsec, workspace access/bootstrap and connection flows | Quiet bordered panels, labeled credentials, explicit disabled/loading/error feedback |
| Home/Inbox/scopes | Dexie unread/working projections, filters, actions, scope cards and channel creation permissions | Semantic cards, status text, compact controls, selected accent |
| Conversations/thread/composer | Thread routing, attachments, reactions, scroll ownership, drafts and send failure | Readable 16px messages, calm sender metadata, bounded modal, focus ring and local control colors |
| Tasks/list/board/detail | Board grouping/filtering, assignments, dates/tags, rich descriptions, dependencies, comments and save leases | 6px actions, 10px cards, readable descriptions, semantic state colors, wrapping controls |
| Documents/editor/wiki | Local draft recovery, checkout, Tiptap, notebook links, backlinks, body hydration and independent scrolling | Theme-aware editor/toolbars, reading text, restrained document panels |
| Files | Workspace-aware signed storage, previews/downloads, upload/publish states | Themed file cards, previews, dialogs and failure feedback |
| Agents/context/toolbox | Presence vs execution state, Autopilot connections, context tree, WApp delegation | Semantic surfaces and controls; mapped Bot icon, original authority boundaries |
| Settings | Workspace/admin gates, connection/FIPS, notifications, apps, members/groups, scopes and repair | Device-local appearance selector, wrapping tabs, paired form/panel tokens |
| Menus/dialogs/approvals | Existing handlers, approval authority, busy exit restrictions and result evidence | Shared focus containment/restoration for modal dialogs, semantic layers, explicit focus and disabled/error states |

## Themes and interaction

The `appearance` Alpine store is presentation-only. `ambulando:theme` stores
`light`, `dark` or `system` on the device. The inline head bootstrap applies the
resolved theme before stylesheet loading; system changes and storage events keep
tabs aligned. This preference never writes to Tower or changes a workspace key.
Dark mode uses explicit token pairs, including native control color schemes.

Desktop controls use 36px minimum height; touch/phone controls use 44px. Product
text is system sans 14px, reading text 16px. Panels have 10px radii, controls 6px;
status badges and actual avatars may stay rounded. Keyboard focus uses `--ring`.
`x-sol-dialog` adds focus containment and restoration only to `aria-modal=true`
surfaces. Existing close/Escape handlers and busy guards remain authoritative.
Nonmodal calendars/popovers retain their existing keyboard primitives.

## Intentional departures and limitations

The product is denser than the reference gallery: existing independent scroll
panes, full-width boards, rich editor toolbars, sync/authority details and view
locks remain because they serve working workflows. Expanded product navigation
moves into the sidebar; the drawer retains scope/channel and workspace controls.
Navigation keeps the original collapsed default; its toggle reveals the complete
expanded Confluence/name navigation.
Baseline-disabled approvals, flows, schedules, people, opportunities and reports
retain their existing feature guards. Their shared presentation is themed; the
redesign does not enable those products or claim browser coverage of gated flows.
Phone inputs remain 16px to avoid Safari focus zoom. Phone date/tag popovers
use bounded sheets above fixed task tabs so 44px controls stay reachable at
320px. The context tree retains its
functional dot/indent guides and checkbox/radio glyphs retain geometric masks;
decorative gradients and glass effects are removed.

Supplied exact Lucide icons replace mapped navigation concepts. Sol extends the pinned source map with FileText for documents, distinct from
Files. Context and Toolbox retain their
existing specialized outline geometry until the design map defines them. Local
icons and their ISC/Feather MIT license live in `public/ambulando`. The closed
inline helper serves the theme control; the same-origin sprite serves navigation.
Existing content/attachment avatars are not replaced with decorative brand marks.
Task-board state/column colors remain data-driven accents, including user-configured
colors, on semantic paired surfaces; their persisted palette contract is retained.

The Confluence symbol is the supplied provisional raster, unchanged. Ivory
backing separates its navy from dark surfaces. The live-type Ambulando name is
an interface treatment, not a claim to the master logo font. Favicon derivatives
preserve proportions with clear space; 16px loses trail definition and 32px is
soft. Final approved vector and optically tuned small artwork remain outstanding.
See `public/ambulando/README.md`, source manifest and asset hashes for provenance.

## Verification

`tests/e2e/ambulando-sol.spec.cjs` renders the built app in isolated browser
contexts with synthetic records and intercepted storage/backend requests. It
checks themes/persistence, connected draft and navigation controls, long reading
content, keyboard modal behavior and phone reflow. Existing task/file/editor
browser suites and unit suites cover their production behavior separately.

Use the configured managed Sol runtime when one exists. For agent-independent
fixture coverage without starting a preview server:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 PLAYWRIGHT_DISABLE_VIDEO=1 bunx playwright test tests/e2e/ambulando-sol.spec.cjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 FLIGHTDECK_PERF_DIST=1 PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:e2e:perf
```

Tower target remains local by default. Intercepted frontend fixtures do not
establish authenticated backend authorization, cross-user delivery, signer
extension behavior or physical phone/WebKit behavior. Review those in an
isolated authorized workspace before releasing a live Sol registration. Runtime
screenshots and run-specific evidence belong only in ignored
`tmp/docs/handoffs/`, never in reusable public source.

## Document paper

Documents use an explicitly white paper surface in both shell themes, per the
writing-workflow preference. The canvas is nominally 210mm wide with a 297mm
minimum height and 20mm writing margins; long content grows without pagination.
The existing document pane owns vertical and horizontal scrolling, so laptop
layouts retain page width alongside independently scrolling comments. Phones
adapt the paper width and use 20px side margins. Paper-local ink, links, code and
border colors stay readable independently of the shell theme. Content storage,
editor instances, checkout, autosave and wiki hierarchy are unchanged.

The A4 cases in `tests/e2e/ambulando-sol.spec.cjs` check both themes at
1440/1280/390px, long-content growth, paper geometry, ink, local overflow,
comment isolation and editor retention while switching phone panes.
