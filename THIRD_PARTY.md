# Reused Canvas interaction code

`src/canvas/interactions.js` is adapted from the BYO Freedom / Freedom Tools
Canvas in `public/app.js`, reconciled at source commit
`dee7d657636ab701573001d782668e97d1bd0064`, and from the earlier host-adapter
extraction in Plan Space `public/canvas.js`, inspected at commit
`f66e5eec0c8f7a325690d6721c51ab6109c47c75`.

It retains viewport mathematics, selection enclosure, selected-set and group
movement, pinch/wheel controls, and arrow endpoint geometry behind Ambulando's
Tower-backed page adapter. Reuse was requested by the project owner. The source
repository did not contain a root license file at extraction; this attribution
does not assert an additional public license.
