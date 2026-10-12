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
| Shell/navigation | Section routing, view locks, scope/channel selection, workspace discovery/switching, profile/sync feedback | Header-only Confluence/name branding, compact rail, local Lucide navigation, responsive drawer, native keyboard buttons |
| Login/onboarding | Ephemeral, NIP-07, bunker/nsec, workspace access/bootstrap and connection flows | Quiet bordered panels, labeled credentials, explicit disabled/loading/error feedback |
| Home/Inbox/scopes | Dexie unread/working projections, filters, actions, scope cards and channel creation permissions | Semantic cards, status text, compact controls, selected accent |
| Conversations/thread/composer | Thread routing, attachments, reactions, scroll ownership, drafts and send failure | Readable messages (16px desktop, compact phone proportions), calm sender metadata, bounded modal, focus ring and local control colors |
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

## Optional views

Settings → Deck layout includes independent Show Agents and Show Context options
alongside Inbox and My Focus. Both default off and persist in the existing
shared device-local app settings, across reloads and workspace changes. They do
not write Tower records or change permissions. Navigation, direct view entry and
browser routes respect these preferences; disabling the active optional view
returns to Deck. Existing agent installations and context records are retained,
and enabling the preference restores access.

## Intentional departures and limitations

The product is denser than the reference gallery: existing independent scroll
panes, full-width boards, rich editor toolbars, sync/authority details and view
locks remain because they serve working workflows. Expanded desktop product navigation
uses the horizontal bar; phones use the fixed bottom view switcher, with
scope/channel and workspace controls in the drawer.
Navigation keeps the original collapsed default; its toggle reveals the expanded
scope/channel sidebar and horizontal desktop product navigation.
On mobile, the branding row retains the logo, hamburger, theme and profile menu.
The compact context row contains workspace home (show all in the workspace),
current scope/channel and Full screen. Focus hides only the branding row and
places a hamburger before workspace home; the context and Show header toggle
remain visible. There is one visible hamburger in either mode. Scope/channel
switching stays in the sidebar. Names truncate with full accessible labels.
Drawer close restores keyboard focus after dialog cleanup, and the fullscreen
control retains focus through both directions. Desktop placement is unchanged.
Both rows and the drawer respect safe-area and visual viewport insets.
Browser fullscreen and external browser chrome remain browser-owned.
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

The Docs workspace, sticky list and editor headers, comments panel and collapsed comments rail use
`--background` in both themes, including the inline document dialog. Controls and
individual comment cards retain their existing semantic surfaces.

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

Expanded desktop sidebars place product view buttons in the horizontal context
bar. The collapsed desktop icon rail retains its navigation. Phones use the
bottom view switcher and reserve its height plus the safe-area inset; the drawer
contains scopes, channels and workspaces without duplicate product views. Mutually
exclusive visibility keeps one reachable product section set. The horizontal
bar scrolls locally when necessary and retains view locks and fullscreen actions.
Visible product copy and installed-app titles use Ambulando. Sol remains the
repository/runtime identifier; this change does not configure its future domain.

Brand lockups retain Ambulando as the product name and place the secondary
Solvitur Ambulando tagline underneath in the header and sign-in panel.
The sidebar has no repeated brand block in either desktop state or the phone
drawer; navigation starts at the top without a reserved branding gap. Uppercase presentation
uses semantic muted text; the underlying text retains its requested spelling.
At 320px the header reduces spacing while retaining readable tagline text and
44px navigation, theme and profile controls.

Modal backdrops use a dim scrim and 6px background blur; dark mode has a
stronger scrim, and dimming remains when backdrop filtering is unavailable.
Modal content keeps its own sharp surface. Channel-menu containers remain
transparent layout wrappers; only their popovers receive floating-surface
styles. The compact Toolbox button centers its icon like the other rail views.

## Markdown code

Fenced code uses paired `--code-*` tokens rather than action-primary colors.
Light mode uses a pale neutral surface with dark ink; dark mode uses navy with
light ink. Syntax, comments, language labels and Copy feedback retain at least
4.5:1 text contrast. The shared renderer and clipboard delegation preserve
source text, whitespace and escaping; each block scrolls long lines locally.
Inline code keeps its surrounding text/paper colors. White Docs paper and its
rich-editor code styling remain independent of the shell theme.

`tests/e2e/markdown-code-contrast.spec.cjs` checks computed text contrast, Copy
hover/focus/success/failure, plain and highlighted copy fidelity, monospace and
horizontal scrolling at desktop and phone widths in both themes. It renders
synthetic Markdown with production renderer/CSS under chat, thread, document,
comment and history ancestors against the configured runtime, blocking backend
requests. It does not establish authenticated delivery or native clipboard
permissions. The connected thread/Docs cases in `ambulando-sol.spec.cjs` also
verify the Chromium clipboard with explicitly granted permissions and preserve
the white paper code colors in both themes. Set `SOL_EVIDENCE_DIR` to a verified ignored handoff directory to
capture screenshots.

## Notification and shared-surface contrast

The update header retains navy in light mode and the blue information surface
in dark mode. Its local `--update-header-*` tokens pair title, disclosure,
actions, border, hover and keyboard outline with that surface. Updating feedback
keeps full ink opacity. Success Copy feedback uses the existing success pair.
Image-preview captions and close controls use opaque card backing and foreground
ink so the underlying content cannot erase them; the close focus ring is inset.

`tests/e2e/theme-contrast.spec.cjs` renders production notification and image
preview constructors with synthetic content and production styles. It measures
composited CSS colours (including colour mixes and opacity) in light/dark themes
at desktop/phone widths, with keyboard, hover, updating, retry and dismissal
checks. It also samples headers, secondary text, input placeholders, buttons,
notifications, tabs, badges, activity text, document metadata and white paper.
Set `SOL_CONTRAST_DIST=1` to test the built CSS and `SOL_EVIDENCE_DIR` to a verified
ignored handoff directory for measurements and screenshots. The sampled cases
target 4.5:1 text and 3:1 meaningful controls/focus indicators; they do not establish
whole-product compliance, arbitrary user-defined status colours or authenticated
backend coverage.

Phone conversation spacing, bounded long-draft/edit/attachment state and
keyboard-visible reading-area checks are specified in
[Phone conversation space](mobile-chat-density.md). Chat inputs stay 16px,
while phone message text uses the classic compact 14px proportion.

## Message action placement

Thread message actions occupy a 44px column beside wrapping sender metadata.
Messages keep their natural height in the scrolling history at every width.
The prose begins below that row and keeps the full body width; neither the
button background nor its hit area covers text. Channel cards reserve heading
space beside their action button. The closed control is transparent, with a
semantic hover surface and the shared keyboard focus ring. Expanded state is
announced; Escape closes the list and restores focus. Native buttons retain
Tab navigation, outside-click dismissal and the existing permission guards.
Action lists scroll within half the viewport height.

`tests/e2e/chat-message-actions.spec.cjs` checks both themes at
320/390/430/768/1440px, long sender names and multiline prose, 150%/200% text
sizes, CDP pinch-scale simulation, geometric separation, selection, scrolling, keyboard and pointer
dismissal, action callbacks, read-only visibility and the compact thread header.
It uses the production store/template with synthetic records and blocked backend
requests; it does not establish authenticated permissions or physical-device
zoom behavior. Optional `SOL_EVIDENCE_DIR` writes screenshots only to ignored,
untracked evidence storage.
