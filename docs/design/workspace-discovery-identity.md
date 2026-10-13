# Workspace discovery identity

Add Tower lists Postgres workspaces through a signed GET to
`/api/v4/flightdeck-pg/workspaces`, first with the configured app namespace and
then without that filter if the first list is empty. Both calls use the current
browser Nostr identity; discovery explicitly disables delegated workspace-key
signing. Tower resolves the authenticated actor, requires workspace membership
and `workspace.read`, and returns only that actor's authorized workspaces.

An empty successful response does not mean Tower contains no workspaces. The
picker shows the full signed-in npub so a member can compare it with the npub
that the workspace owner added. If they differ, the member must sign in with
the added identity. If they match, the owner should check membership and access.
A profile name or avatar is not proof that two devices use the same Nostr key.

On a fresh device, Sign Up creates a local identity. It does not recover an
identity from another device or transfer existing workspace membership. The
sign-in screen explains this distinction. The picker can close and invoke the
existing logout path to return to sign-in without creating another workspace.

Do not grant an unknown identity access based on a matching profile or a
shortened npub. Confirm the intended full public identity before changing
membership. Browser sign-in must remain under the human's control.

`tests/e2e/remote-workspace-picker.spec.cjs` covers visible authorized rows,
identity guidance on empty discovery, narrow-screen npub wrapping, suppression
while loading or on request failure, and returning to sign-in.
