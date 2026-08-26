# Changelog

## Unreleased

- The `pi` wrapper script installed by Sandburg
  (which enforces Sandburg restrictions on nested `pi` commands)
  used to execute the parent Pi executable.
  It now simply executes `pi` from `PATH`, which is both simpler and less surprising.

## [0.1.1] - 2026-05-17

- Forward Sandkasten nested-sandbox path-policy variables `SKN_PATH_CHECK`
  and `SKN_RO_BINDS` through the Sandburg tool sandbox by default.

## [0.1.0] - 2026-05-17

- Initial public release
