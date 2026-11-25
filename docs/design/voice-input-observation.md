# Browser voice input observation

The existing voice-note dialog lists browser-enumerated audio inputs and System
default before Start. Enumeration does not request an extra capture. Browsers may
hide names and devices until permission is granted; Start requests the selected
input, or the existing `audio: true` constraint for System default. Named choices
use an exact device constraint; missing choices report an error and let the user
choose again. Preference is retained only in the current browser app session.

During capture, selection is locked to preserve the clip. Active input comes
from the captured track label or its settings device ID matched to enumeration.
A missing route is explicitly unknown; a mismatched reported device is explained
separately from the preference. Browser/OS routing remains authoritative.

A Web Audio analyser reads the same stream passed to MediaRecorder, with no
speaker connection and no second getUserMedia request. RMS below 0.003 is quiet;
levels above it scale to the meter's 0–1 range. There is no decorative animation
or interpolation, including under reduced motion. Unsupported/suspended analysis
reports unavailable rather than inventing sound. The elapsed clock updates once
per second. Stop, cancel, recorder failure and disconnection release observation;
cancel also removes device callbacks, closes capture and revokes preview URLs.
Delayed permission/stop/upload results cannot revive a cancelled recorder.

Stop preserves the original upload-to-draft behavior. Failed upload retains its
preview/blob for retry; successful upload attaches a pending transcript draft.
Explicit Send still owns message/comment creation and audio-note materialization.
No backend or shared record contract changes are required.

Focused tests use synthetic tracks, recorder events and generated samples. Browser
fixtures use real Web Audio/MediaRecorder with generated tone and silence plus
injected device/permission reports; they do not establish physical microphone,
Bluetooth/USB routing, real permission prompts, live upload or transcription.
