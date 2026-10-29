# Channel creation and recovery

Named channel creation uses explicit Tower-supported person/group grants. The creator always retains Manage in the
creation form: a stale self row cannot replace Tower's creator recovery bundle with View or Contribute. Other access
rows remain deliberate choices. Creating a channel never repairs another channel's audience or infers group membership.

Tower's creator bundle includes the legacy `channel.grant` alias alongside standard Manage permissions. The access
editor recognizes exactly that bundle as Manage. Saving unchanged Manage preserves the alias; explicitly selecting
View or Contribute submits the selected standard bundle, removing management rights. Unknown custom bundles remain
protected from preset editing and bulk replacement. Custom scope defaults retain their exact concrete permissions
when copied into a creation draft; removing one and adding a different row is an explicit choice.

Scope defaults are draft suggestions, not authority over existing channels. They can be displayed alongside direct
channel grants, with direct channel rows overriding matching default rows, but they never enable channel management
controls. Scope/context roles remain separate from channel participation. Tower decides every read and mutation.

Web regression coverage includes creator recognition, unchanged roundtrip versus explicit downgrade, creator recovery
at creation, custom default preservation, direct overrides and denied management from a scope default. Browser fixtures
use intercepted local Tower requests; live release evidence belongs on the task. Native iPhone/Mac uses the same
existing API with its own SQLite renderer; its channel access behavior is documented in that repository.
