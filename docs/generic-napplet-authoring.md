# File napplet authoring

A v2 napplet is a self-contained HTML File with the manifest described in
[the portable protocol](design/generic-napplet-v2.md). Its code File metadata
binds one capability to an existing resource. Use ordinary NStack File upload
and version CAS. Keep code authorship and resource access separate: a shared
code File does not confer access to another person's private JSON.

In Apps settings choose **Add napplet**, select a synchronized File or paste
its Ambulando File link. A File ID is also accepted. Installation verifies code
and bound resources, then saves a personal File bookmark. Approve the verified
code before it runs. Uninstall removes only the bookmark. Files and data remain.
Every open rechecks authority and loads the current immutable version. **Check
for update** reopens that same File; changed code or bindings ask for approval.
No app ID registration, client rebuild or host source edit is needed.

The picker lists synchronized Files on this device, not a complete workspace
catalogue. Direct File links work without a bookmark. Unsupported manifests,
capabilities or unavailable resources never fall back to an ordinary bridge.

To author the report as a separate v2 app, without changing the frozen v1 app:

```sh
bun scripts/package-generic-workspace-report.mjs /path/to/report.html
```

Publish those bytes as an HTML code File with metadata:

```json
{"html_artifact":true,"napplet":{"version":2,"app_id":"workspace-report-generic","bindings":{"summary":{"workspace_id":"<current workspace UUID>"}}}}
```

Share the stable File link with intended readers. Each reader installs and
approves it using their own identity; the aggregate capability queries only
their authorized records. An unavailable server API displays unavailable counts.
No bundled sample values substitute for a live aggregate response.
