# Document opening mode

Settings → Deck → Default document opening mode offers View and Edit. Existing
documents open in View when the signed-in user has no explicit choice. Choosing
Edit requests entry through the existing edit permission and lease flow; denial
keeps the document in View. Manual View/Edit switching does not save a preference.
New-document creation keeps its explicit edit intent.

The browser stores only explicit choices in `app_settings.documentOpeningModes`,
keyed by the signed-in user's npub. This is browser-local, shared across that user's
workspaces, and independent of workspace ownership and delegated signing keys.
Dexie live observation projects changes from other tabs. No editor mode or draft
state is imported as a preference, including for existing installations.

The Swift clients use the catalog's existing `app_state` storage, with a dedicated
user-keyed `native.document-opening-mode.v1` value. The choice is device-local,
shared across that user's workspaces. Web and native choices do not synchronize
between devices. No shared backend contract changes are required. Android still
needs this setting and View-by-default behavior.

Document draft recovery, explicit edit actions, lease acquisition, autosave and
offline drafts retain their existing contracts. A preference change affects the
next open; it does not interrupt a document already being read or edited.
