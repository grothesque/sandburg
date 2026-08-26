# Sandburg: a Pi sandbox balancing security, usability and agent autonomy

Sandburg is the *inner component* of a comprehensive sandboxing solution
for the [Pi LLM agent harness](https://pi.dev/).
The recommended *outer component* is
[Sandkasten](https://github.com/grothesque/sandkasten),
which can sandbox the Pi process itself.

Sandburg and Sandkasten are independent but designed to complement each other.
Sandkasten limits what Pi can see and do;
Sandburg further restricts what built-in agent tools can do.
Sandkasten is not a strict technical dependency;
it can be replaced by an equivalent custom sandbox.

Both Sandburg and Sandkasten rely on [bubblewrap](https://github.com/containers/bubblewrap),
a low-level sandboxing tool
that itself is a thin wrapper around Linux kernel sandboxing primitives.
This is a Linux-only solution.

**Important**: Sandburg alone is not a filesystem read sandbox.
Without an outer sandbox, Pi and its tools can still read most files visible to Pi,
and the agent can send readable data to the model provider.
Local socket files used by SSH or GnuPG agents, desktop sessions, or other local services
may also be reachable unless hidden by the outer sandbox.
Use Sandkasten or an equivalent outer sandbox to limit what Pi itself can access.

## Sandbox policy and behavior

Sandburg constrains Pi’s built-in agent tools so that, through those tools,
the agent

- cannot use ordinary IP networking from sandboxed tool subprocesses,
- cannot launch processes that outlast a tool call,
- cannot read or mutate Pi’s private agent state,
- cannot read or mutate additional private state paths configured by the user.

By design Sandburg does not intercept Pi’s user bash commands, such as `! command` and `!! command`.
They are treated as deliberate user actions and run under whatever restrictions apply to the Pi process itself.
This gives the user a way to bypass the limitations of the agent’s `bash` tool,
in a way that is visible (`!`) or hidden (`!!`) to the agent.

Sandburg also adjusts the agent-facing `bash` tool description
to say that tool commands have no network access.
The agent is instructed to ask the user to run networked commands,
rather than working around normal workflows.

In practice, this means that the agent can use its tools autonomously,
while the user retains control over network access and,
when an outer sandbox is used as described below, file access.

Sandburg reports its state in Pi’s status line.
Use `/sandburg` for the full status report,
including information about a possible outer sandbox.

## Installation

### Recommended Sandkasten + Sandburg setup

Consult [Sandkasten documentation](https://github.com/grothesque/sandkasten#readme)
for details.
Both Sandkasten and Sandburg require `bwrap`;
Sandburg also requires a real `rg` outside Pi’s agent bin directory.
See [Sandburg setup details](#sandburg-setup-details).

Prepare Sandkasten, then install Sandburg:

1. Install `skn`, the Sandkasten shell script, somewhere in `PATH`.
2. Configure the basic Sandkasten policy by setting the `SKN_PATH_CHECK`
   and `SKN_RO_BINDS` environment variables.
3. Verify the basic Sandkasten policy by running `skn true +S`.
4. From a project directory, test the sandbox:
   `skn bash +W.`
   Confirm that files are accessible or hidden as desired.
   In particular, make sure that the Pi executable and its package root are available.
   This often requires adding the npm prefix directory
   (returned by `npm config get prefix`)
   to `SKN_RO_BINDS`.
5. Define shell aliases (or scripts, or shell functions) for launching Pi
   within Sandkasten.
   For example:
   ```sh
   pi_agent_dir="$HOME/.pi/agent"
   npm_prefix=$(npm config get prefix)
   npm_cache=$(npm config get cache)
   mkdir -p "$pi_agent_dir/bin" "$npm_cache"

   alias skn-pi='skn pi \
     +W "$pi_agent_dir" \
     +T "$pi_agent_dir/bin" \
     +N'

   alias skn-pi-admin='skn-pi \
     +W "$npm_cache" \
     +W "$npm_prefix"'
   ```
6. Install Sandburg as a normal Pi package:
   ```sh
   skn-pi-admin install npm:@grothesque/sandburg
   ```

The `+T` option above serves to make any writes to the directory `~/.pi/agent/bin`
ephemeral.
This way, the helper files that Sandburg writes there,
will be only visible to the sandboxes Pi process.
The `+N` option grants network access to Pi itself,
so that it can communicate with the model provider.

### Usage

Run the sandboxed Pi with `skn-pi`.
Sandburg status should appear in Pi’s status line;
if it shows a warning or disabled state, run `/sandburg`.

The alias accepts Pi’s regular command-line arguments.
For example:
```sh
skn-pi --help
skn-pi --model some_model
echo "1 + 1" | skn-pi
```

It also accepts Sandkasten `+` options:
```sh
skn-pi +S            # Show the sandbox setup, including bwrap invocation.
skn-pi +W.           # Allow writes to the current directory.
skn-pi +T. +W build  # Discard cwd writes except in build.
```

By default, apart from Sandkasten’s minimal system/runtime view and private `/tmp`,
the wrapper exposes the paths in `SKN_RO_BINDS` read-only
and Pi’s agent directory writable.

Sandkasten and Pi options can be mixed,
but Sandkasten options must come first:
```sh
skn-pi +W. --model other_model
```

Despite that restriction, shell aliases can still include Pi options
by using Sandkasten’s special `+A` option:
```sh
alias skn-pi-other='skn-pi +A --model +A other_model'
```

Use `skn-pi-admin` for Pi package-management and update commands,
for example `skn-pi-admin update`.

### When Pi is not on the host `PATH`

The setup above assumes that `pi` is available on the host `PATH`.
Users who
[systematically sandbox all Node and npm executables](https://github.com/grothesque/sandkasten/blob/main/EXAMPLES.md#systematically-sandboxing-node-and-npm)
may instead keep npm’s global executable directory out of the host `PATH`,
which also removes `pi` from it.
In that setup, replace the `skn-pi` and `skn-pi-admin` aliases above with
launchers that invoke Pi by its absolute path and add its executable directory
to `PATH` only inside the sandbox:
```sh
pi_agent_dir="$HOME/.pi/agent"
npm_prefix=$(npm config get prefix)
npm_cache=$(npm config get cache)
mkdir -p "$pi_agent_dir/bin" "$npm_cache"

alias pi='skn $npm_prefix/bin/pi \
  +V "PATH=$npm_prefix/bin:$PATH" \
  +W "$pi_agent_dir" \
  +T "$pi_agent_dir/bin" \
  +N'

alias pi-admin='pi \
  +W "$npm_cache" \
  +W "$npm_prefix"'
```

The above assumes that the Pi executable is in the `bin` subdirectory under the npm prefix directory.
Adjust if necessary.
The `+V PATH=...` assignment makes `pi` available inside the sandbox.

### Sandburg setup details

A real ripgrep binary (`rg`), for example from your system ripgrep package,
must be available *outside* Pi’s agent bin directory,
typically `~/.pi/agent/bin`.
Sandburg installs managed helper wrappers in that directory,
including a `rg` wrapper.
If an unmanaged `rg` is already there
Sandburg will report a setup violation and disable tools until resolved/reloaded.

(The helper files are recreated automatically and may be removed
when Pi is not running.
With the recommended Sandkasten setup,
they live only inside Pi’s temporary sandbox.)

Sandburg treats Pi’s agent directory, including `~/.pi/agent/bin`, as private state
and hides it from sandboxed agent tools. Put user helper commands that the agent
should run in another visible `PATH` directory, such as `~/bin` or a project-local `bin/`.

#### Environment variables

Agent-launched tool commands run with a mostly cleared environment.
Common shell variables such as `HOME`, `PATH`, `LANG`,
and locale variables are forwarded if set.
To support nested Sandkasten use from the agent `bash` tool,
Sandburg also forwards `SKN_PATH_CHECK` and `SKN_RO_BINDS` when they are set.
To intentionally pass additional trusted variables from the Pi process,
set `SANDBURG_PASS_VARS` to a colon-separated exact-name allowlist.

Sandkasten clears most environment variables by default.
Pass trusted Sandburg-related variables through Sandkasten with `+V`
when you want them to affect the Pi process and Sandburg’s tool sandbox.

To suppress the additional-tool warning for extension tools that you intentionally trust,
set `SANDBURG_TRUSTED_EXTENSIONS` to a comma-separated list of exact trust keys.
Run `/sandburg` to see the key reported for each active extension tool,
then copy the intended key into the environment variable.
For package extensions the key is Pi's package source string, such as `npm:pi-subagents`;
for other extensions it is the extension path reported by Pi.
Trust only suppresses Sandburg's warning for those extension tools;
it does not sandbox extension code or relax Sandburg's built-in-tool checks.

For expert troubleshooting,
`SANDBURG_DISABLE_PROPAGATION=pi-wrapper,sdk` disables nested-session propagation mechanisms.
This weakens subagent protection and should normally be unset.

#### Extra private paths

If the outer sandbox must expose additional Pi-private state paths,
such as a symlink target for `~/.pi/agent/sessions`,
list them in `SANDBURG_PRIVATE_PATHS`.
This colon-separated list names additional absolute existing directories
that Sandburg should hide from sandboxed subprocess tools
and deny to `read`, `write`, and `edit`.
Sandburg automatically protects its helper bin backing directory,
even if `~/.pi/agent/bin` is itself a symlink.
This variable is meant for other private-state aliases.

#### Nested Pi sessions (subagents)

Sandburg tries to load itself into ordinary nested Pi sessions,
including child `pi` processes and SDK-created sessions.
For child processes, Sandburg puts a managed `pi` wrapper first on `PATH`.
Whenever it runs, the wrapper delegates to the next `pi` on that invocation's
`PATH`. While Sandburg is active, the wrapper explicitly loads Sandburg for
commands that may start an ordinary Pi session; package-management and
help/version commands are delegated unchanged. If no downstream `pi` is
available, the wrapper reports an error when invoked; this does not affect
sessions that do not launch child Pi processes.
This is best-effort compatibility,
not a boundary against malicious extension code.
Use `/sandburg` to check propagation status,
and verify subagent behavior if it matters for your workflow.

## How Sandburg protects Pi tools

Since the agent’s tools operate within the Pi process,
they are already restricted by the outer sandbox, if one is in place.
In addition, Sandburg restricts the built-in tools in the following way:

- `bash` is redefined so that each command is executed through
  Sandburg’s bubblewrap helper.
- `grep` remains Pi’s grep tool,
  but Sandburg installs and verifies a managed `rg` wrapper
  at the lookup point used by that tool,
  so searches enter the same sandbox.
- `read`, `write`, and `edit` are wrapped with policy checks
  before delegating to Pi’s normal implementations.
  `read`, `write`, and `edit` are also made sequential to avoid same-turn
  path-policy races.
- `ls` and `find` remain Pi’s ordinary built-in tools.
  They do not read file contents or access the network,
  but they may still show file and directory names.

For nested sessions,
Sandburg also installs best-effort propagation hooks as described above.
On each reload, Sandburg ensures that the core built-in-tool contract is valid.
If it is not, it disables all tools and warns the user.
Run `/sandburg` after launch or `/reload` to inspect helper setup,
private Pi/Sandburg state roots, outer-sandbox signals, active extra extension tools,
and nested-session propagation status.

Note: Sandburg does not intercept Pi user bash commands (`!` and `!!`),
but `! rg ...` and `! pi ...` will typically use Sandburg’s managed wrappers.
For `! pi ...`, this normally helps by propagating Sandburg into the child Pi.
To bypass these wrappers intentionally,
invoke the real binary directly,
for example `/usr/bin/rg` or the real Pi path for your system.

## Threat model and limitations

A carefully set up Sandburg + Sandkasten is meant to be
a useful component of a defense-in-depth approach
against supply-chain attacks and agent prompt injection.

The primary supported security configuration is Sandburg inside Sandkasten
or an equivalent outer sandbox.
Sandburg does not sandbox the Pi process itself.
Without an outer sandbox,
Sandburg provides reduced protection rather than general data containment.
An outer sandbox is the robust way to restrict what files, services, and secrets Pi can access.

Even with Sandkasten and Sandburg together, isolation depends on bubblewrap
and Linux kernel sandboxing primitives.
A bug in bubblewrap or an exploitable kernel vulnerability could allow
sandbox escape.

Sandburg does not constrain agent tools beyond the built-in ones.
Extension code and extension-provided tools remain trusted code running with the Pi process’s permissions.
The `/sandburg` command lists any such additional tools that are active.

## Development

Install dependencies and run checks with:
```sh
npm ci
npm run check
npm test
```

For local development or one-off testing,
load Sandburg explicitly from the working tree:
```sh
pi -e .
pi -e extensions/sandburg/index.ts
```

See `tests/README.md` for test-suite details.
