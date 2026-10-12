# Phone page spacing

The phone Toolbox heading places Add WApp beside the title and keeps its
explanatory copy below. App rows retain icon, title, URL/description, visibility,
ordering, Edit and Archive. Scoped phone rules undo inherited full-width
checkbox styling: the labelled visibility target and action buttons are at
least 44px high. Narrow WApp rows may wrap Archive; napplet controls fit one row.
The page keeps its existing scroll owner and desktop layout.

Phone channel Chat cards show two title lines. Full title text stays in the
heading DOM and its title attribute, and the complete message remains available
in the existing preview/thread flow. Thread reading, composer and history
scrolling are unchanged. Files source tabs reserve real 44px icon columns and
use tighter internal spacing so ordinary labels/counts fit at 320px. Larger
counts may wrap without shrinking the touch target.

The audit reviewed Deck, channel Chat/thread, Tasks/list/detail, Docs/list/editor,
Files and Toolbox at 320/390px with a 1280px desktop comparison. Deck pagination,
compact task front matter, collapsed list options and phone editor paper were
retained. The Docs paper margins support the existing writing workflow. Files
root breadcrumbs retain their navigation role even when the source label repeats.
Long Files action labels may wrap; preserving visible actions is preferable to
adding a new menu in this focused change.

`tests/e2e/mobile-page-space.spec.cjs` uses production built templates/styles and
synthetic records with blocked backend traffic. It checks compact geometry,
44px controls, visibility/order/archive callbacks, Add/Edit editor entry, full
Chat text and keyboard thread opening, Files search/source switching/add menu,
phone overflow and both themes with a desktop comparison. Optional
`SOL_EVIDENCE_DIR` must be ignored and untracked. Existing mobile layout,
Deck spacing and conversation density tests cover navigation, safe areas and
keyboard viewport reading space. Chromium simulations do not establish physical
iOS/WebKit behavior or authenticated backend delivery.

For a served-asset check, set `SOL_PAGE_SPACE_LIVE=1` and `PLAYWRIGHT_BASE_URL`
to the explicit managed site URL. The fixture allows only that site's static
requests, blocks API/external traffic, and seeds synthetic records. This checks
served behavior without using private workspace data or claiming live writes.
