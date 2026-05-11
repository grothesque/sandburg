# Sandburg tests

Sandburg’s tests are meant to exercise the extension’s public behavior
without using Pi’s TUI, tmux, real model providers, API keys, or the network.

## Running

Run the full suite from the repository root:

```sh
./tests/run
```

`tests/run` checks its shell syntax
and then runs the Node test files serially
with `node --test --test-concurrency=1`.

Most tests use the Pi SDK.
If Pi is not installed as a local dependency
and is not discoverable on `PATH`,
point the tests at a Pi CLI:

```sh
PI_BIN=/path/to/pi ./tests/run
```

Package-layout overrides are also supported when needed:

```sh
PI_CODING_AGENT_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent ./tests/run
PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent ./tests/run
```

The optional Sandkasten integration test discovers `skn`
from `SKN_BIN` or `PATH`:

```sh
SKN_BIN=/path/to/skn PI_BIN=/path/to/pi ./tests/run
```

Some tests skip when host prerequisites are unavailable or unusable:

- Pi CLI: CLI/RPC smoke tests.
- `bwrap`: tool-sandbox execution tests.
- `skn`: optional Sandkasten integration.

## Design

The suite has three layers:

1. **SDK tests with faux model responses** for detailed Sandburg behavior.
   These run in-process and are deterministic.
2. **Sparse CLI/RPC smoke tests**
   to prove real Pi can load Sandburg and the test provider extension
   in non-interactive modes.
3. **Optional Sandkasten integration**
   to smoke-test the recommended outer + inner sandbox composition
   when Sandkasten is available.

Tests intentionally avoid Pi’s TUI.
They assert stable semantics such as tool names,
success/error booleans,
short result substrings,
and filesystem side effects.
They should not snapshot full event streams,
generated timestamps,
UUIDs,
mount listings,
or terminal/UI formatting.

Each test uses a fresh temporary project directory and Pi agent directory.
Pi subprocess tests use a small explicit environment
rather than inheriting the user’s full environment.
Normal test runs should not depend on the user’s real `~/.pi/agent`,
installed extensions,
real LLM credentials,
or network access.

## Extending the suite

Prefer SDK/faux-provider tests for Sandburg behavior.
Add CLI/RPC tests only for coarse integration coverage through real Pi modes,
and keep Sandkasten tests optional and skippable.

Guidelines:

- Keep each test focused on one behavior axis.
- Use fresh temp dirs and a fresh `PI_CODING_AGENT_DIR`.
- Use `PATH=/usr/bin:/bin`
  unless the test explicitly needs the Pi CLI’s bin directory
  or an agent-bin wrapper.
- Do not pass the user’s full environment to subprocesses;
  use `piSubprocessEnv()` or another explicit env.
- Load Sandburg explicitly;
  do not rely on auto-discovered extensions.
- Use faux/scripted model responses;
  do not make real model or network calls.
- Assert behavior, not implementation details.
  Stable helper markers are OK;
  exact generated helper script contents are usually too brittle.
- Keep helper abstractions narrow.
  Test-specific setup and assertions should remain visible in the test file.

Important caveats:

- Sandburg reads some env-derived constants,
  such as `PI_CODING_AGENT_DIR` and `SANDBURG_RO_PATHS`,
  when its modules load.
  Tests that vary those values need isolation
  and should keep them stable for a harness session.
- Pi provider/API registration can involve process-global state.
  Use unique provider names
  and always dispose harnesses so faux providers are unregistered.
- `grep` is not a default active tool in SDK sessions;
  enable it explicitly with a `tools` allowlist when testing it.
- `bwrap` must be usable on the host/kernel,
  not merely installed.
- Sandkasten integration verifies defense-in-depth composition
  and should not be required for ordinary Sandburg development.

## Troubleshooting

- `Cannot import @earendil-works/pi-coding-agent`:
  install local dependencies,
  put `pi` on `PATH`,
  or set `PI_BIN`, `PI_CODING_AGENT_PACKAGE_DIR`, or `PI_PACKAGE_DIR`.
- CLI/RPC tests are skipped:
  set `PI_BIN` or put `pi` on `PATH`.
- Tool-sandbox tests are skipped or fail:
  check that `bwrap` works on this host.
- Sandkasten test is skipped:
  set `SKN_BIN` or put `skn` on `PATH`;
  the test is optional.
