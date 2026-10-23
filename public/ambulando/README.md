# Ambulando identity and local icons

## Active perspective-passage identity

The app uses the approved refined16D `refinement-B.png` from the perspective-passage treatment (version 1). `passage-master.png` is byte-identical (SHA-256 `8f3988cf0fe7c14e28776955ffd07ad459f49eaf23532c16db0ca93b8158244b`). `passage-prompts.json` preserves the exact source prompts, selection and source hashes. No geometry or colour was redrawn. The original has opaque white backing and residual AI raster tonal variation; it is not a transparent, vector, one-ink, print or manufacturing master. Brand artwork retains its private provenance.

`passage-app.png` is a 256px proportional raster resample. Header tiles are 40px desktop and 32px phone, with white backing and the source canvas retained; sign-in uses 64px. This deliberately retains compact app dimensions instead of the proposal’s preferred 48px header. `passage-{16,32,180,192,512}.png` retain the complete source canvas at those sizes. `passage-social.png` centers a 500px resample on a 1200×630 opaque white canvas. Derivatives use ImageMagick default proportional resizing, without sharpening, recolouring, invented geometry or alpha removal.

Small icons were visually inspected at native size and enlarged with nearest-neighbour pixels: 32px retains the layered silhouette, broad passage and orange/purple base, but the terminal is soft; 16px retains only the overall silhouette and two base colours, with indistinct gaps and terminal. These are **raster derivatives, not optically tuned masters**. A faithful optical/vector master remains a separate artwork deliverable and does not block this app release. The social image is delivered, but image metadata is deferred until a public canonical product origin is configured. Private managed hosts must not be embedded in public source; title/description metadata remains active.

## Retained rollback artwork

The older Confluence assets and favicon files below remain unchanged for rollback. They are not referenced by active app branding. The historical source manifest remains exact; asset-hashes.json includes both generations.


Imported from Ambulando design system v5.0.0. `source-manifest.json` retains the supplied package provenance and original SHA-256 values; `asset-hashes.json` records imported and derived file hashes.

`confluence-approved.png` is the byte-identical approved original v3 favourite-a artwork preserved through v4. `confluence-symbol-provisional.png` is the byte-identical v4 AI-extracted transparent mark. It is provisional raster artwork, with visible edge artifacts and gradients; it is not an approved vector master. No shapes have been redrawn, recolored, or simplified. Use the symbol with the live-type Ambulando name in expanded navigation and the symbol alone in collapsed navigation. Keep the navy separated from dark surfaces with ivory backing. Preserve aspect ratio and quarter-symbol-height clear space; never clip the trails. The live-type name is an interface treatment, not a claim about the original logo font.

`favicon-{16,32,180,192,512}.png` are raster derivatives of the provisional symbol. ImageMagick trims only transparent canvas, resizes proportionally to fit within two thirds of the output square, and centers on ivory `#FAF8F1`. This provides at least a quarter visible-symbol-height clear space per side without cropping the artwork. These derivatives are not replacement masters or optically tuned favicon artwork. At 16px the three trails lose definition; at 32px they remain distinguishable but soft. Final approved vector and optically tuned small-size artwork remain outstanding.

The 24 local Lucide SVGs are copied exactly from supplied official sources at commit `a04f228cd01185e09c188b7227b9600c08c565ec`. `icons.json` is the supplied mapping; `icons/LICENSE` contains ISC and inherited Feather MIT terms. `icons.svg` packages the same geometry as named symbols. `src/sol-icons.js` exposes a closed map of decorative inline SVG strings with `currentColor`; use `solIcon(name)` only with known keys and keep accessible labels on the enclosing control. No CDN or DOM-wide observer is required. Normal size is 16px, navigation 20px, empty-state cue 24px, stroke width 2. A same-origin sprite can alternatively use `<svg ... fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="/ambulando/icons.svg#list-todo"/></svg>`.

Brand assets retain their private provenance. Icon licensing does not grant a license to the brand artwork.

Sol extends the v5 icon mapping with official Lucide `FileText` for Documents, editor and wiki navigation, distinct from adjacent `Files`. `icons/file-text.svg` is fetched byte-for-byte from the same pinned official Lucide commit and inherits the existing license. `icons.json`, the sprite and trusted map include this explicit application extension. `source-manifest.json` remains unchanged as the exact upstream v5 manifest; it does not claim this extension was supplied by v5.
