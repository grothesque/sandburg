# Changelog

## [0.1.2] - 2026-09-30

- Accept Pi 0.99.0's `builtin:grep`-style tool source paths alongside the older
  `<builtin:grep>` form, preventing false setup failures.
- The `pi` wrapper script installed by Sandburg
  (which enforces Sandburg restrictions on nested `pi` commands)
  used to execute the parent Pi executable.
  It now simply executes `pi` from `PATH`, which is both simpler and less surprising.

## [0.1.1] - 2026-05-17

- Forward Sandkasten nested-sandbox path-policy variables `SKN_PATH_CHECK`
  and `SKN_RO_BINDS` through the Sandburg tool sandbox by default.

## [0.1.0] - 2026-05-17

- Initial public release
