# Sandburg tests

Sandburg’s tests are meant to exercise the extension’s public behavior
without using Pi’s TUI, tmux, real model providers, API keys, or the network.

## Running

Install development dependencies first:

```sh
npm ci
```

Run the full suite from the repository root:

```sh
npm test
```

`npm test` runs `./tests/run`.
The runner checks its shell syntax
and then runs the Node test files serially
with `node --test --test-concurrency=1`.
When run through npm, the local `node_modules/.bin/pi`
is found before any `pi` on the user’s `PATH`.
Direct `node --test ...` and `./tests/run` invocations also prefer
explicit package overrides and the repo-local Pi dev dependency
before scanning `PATH`.
This keeps tests independent of Sandburg's managed agent-bin wrapper,
which lives in private agent state and may be hidden from sandboxed tools.

To test against another Pi installation,
point the tests at a Pi CLI:

```sh
PI_BIN=/path/to/pi npm test
```

Package-layout overrides are also supported when needed:

```sh
PI_CODING_AGENT_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent npm test
PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent npm test
```

Some tests skip when host prerequisites are unavailable or unusable:

- Pi CLI: CLI/RPC smoke tests.
- `bwrap`: tool-sandbox execution tests.

## Design

The suite has two layers:

1. **SDK tests with faux model responses** for detailed Sandburg behavior.
   These run in-process and are deterministic.
2. **Sparse CLI/RPC smoke tests**
   to prove real Pi can load Sandburg and the test provider extension
   in non-interactive modes.

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
with the host’s `PATH` rather than inheriting the user’s full environment.
Normal test runs should not depend on the user’s real `~/.pi/agent`,
installed extensions,
real LLM credentials,
or network access.

## Extending the suite

Prefer SDK/faux-provider tests for Sandburg behavior.
Add CLI/RPC tests only for coarse integration coverage through real Pi modes.

Guidelines:

- Keep each test focused on one behavior axis.
- Use fresh temp dirs and a fresh `PI_CODING_AGENT_DIR`.
- Use the host `PATH` by default.
  Control `PATH` explicitly when testing executable selection,
  such as wrapper ordering or the absence of a downstream `pi`.
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
  such as `PI_CODING_AGENT_DIR` and `SANDBURG_PRIVATE_PATHS`,
  when its modules load.
  Tests that vary those values need isolation
  and should keep them stable for a harness session.
- Use unique faux provider names and a fresh model runtime for each SDK harness.
  Always dispose harnesses to release session-scoped state.
- `grep` is not a default active tool in SDK sessions;
  enable it explicitly with a `tools` allowlist when testing it.
- `bwrap` must be usable on the host/kernel,
  not merely installed.

## Troubleshooting

- `Cannot import @earendil-works/pi-coding-agent`:
  run `npm ci`,
  or set `PI_BIN`, `PI_CODING_AGENT_PACKAGE_DIR`, or `PI_PACKAGE_DIR`.
- CLI/RPC tests are skipped:
  run `npm ci` if needed, then `npm test`; set `PI_BIN`; or put `pi` on `PATH`.
- Tool-sandbox tests are skipped or fail:
  check that `bwrap` works on this host.
