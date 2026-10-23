# Change set of an OpenTofu plan (`tofu show -json`): resource addresses and actions only, no values,
# so it can be shown, compared and passed between jobs without exposing anything secret.
[
  .resource_changes[]?
  | select(.change.actions != ["no-op"] and .change.actions != ["read"])
  | { address, actions: .change.actions }
]
| sort_by(.address)
