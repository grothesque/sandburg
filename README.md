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
a low-level sandboxing tool used by Flatpak.
Bubblewrap is itself a thin wrapper around Linux kernel sandboxing primitives,
so this is a Linux-only solution.

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
- cannot access select sensitive Pi data such as `auth.json` credentials and the `/tmp/jiti` cache,
- cannot write to Pi’s agent directory
  or to additional protected paths specified by the user.

By design Sandburg does not intercept Pi’s user bash commands, such as `! command` and `!! command`.
They are treated as deliberate user actions and run under whatever restrictions apply to the Pi process itself.
This gives the user a way to bypass the limitations of the agent’s `bash` tool,
in a way that is visible (`!`) or hidden (`!!`) to the agent.

The agent-facing description and guidance for the `bash` tool are adjusted
to inform the agent that it does not have network access.
In particular, the agent is instructed to

- ask the user to execute commands that require network access,
  for example using `! command` in Pi,
- not abandon common workflows just because network access is unavailable
  to its own tools.

In practice, this means that the agent can use its tools autonomously,
while the user retains control over network access and,
when an outer sandbox is used as described below, file access.

The status of the sandbox, including information about a possible outer sandbox,
can be viewed with the `/sandburg` command.

## Installation and setup

Sandburg requires `bwrap`.
A real ripgrep binary (`rg`) must be available *outside* Pi’s agent bin directory,
typically `~/.pi/agent/bin`.
Sandburg installs managed helper wrappers in that directory,
including `rg` and `sandburg-tool-sandbox`.
If an unmanaged `rg` is already there
Sandburg will report a setup violation and disable tools until resolved/reloaded.

(The helper files are recreated automatically and may be removed
when Pi is not running.
With the recommended Sandkasten setup,
they live only inside Pi’s temporary sandbox.)

### Installing Sandburg

Install Sandburg as a normal Pi package:
```sh
pi install npm:@grothesque/sandburg
```

Then start Pi normally.
On first run, use the `/sandburg` command to verify that Sandburg is active
and to review the reported sandbox status.

### Environment variables

Agent-launched tool commands run with a mostly cleared environment.
Common shell variables such as `HOME`, `PATH`, `LANG`,
and locale variables are forwarded if set.
To intentionally pass additional trusted variables from the Pi process,
set `SANDBURG_PASS_VARS` to a colon-separated exact-name allowlist.
Entries must be non-empty shell variable names and cannot begin with `SANDBURG_`.
Listed variables that are not exported are omitted.

Sandkasten clears most environment variables by default.
Pass trusted Sandburg-related variables through Sandkasten with `+V`
when you want them to affect the Pi process and Sandburg’s tool sandbox.
For expert troubleshooting,
`SANDBURG_DISABLE_PROPAGATION=pi-wrapper,sdk` disables nested-session propagation mechanisms.
This weakens subagent protection and should normally be unset.

### Extra read-only paths

Sometimes, the outer sandbox needs to grant the Pi process write access
to additional paths.
For example, if `~/.pi/agent/sessions` is a symlink to `~/pi-sessions`,
then Pi will need write permission for the latter directory.
Sandburg’s tool sandbox would not know about this path setup,
and the tools would therefore have write access there.
To handle such cases, set `SANDBURG_RO_PATHS` to a colon-separated list
of additional absolute existing paths that Sandburg should protect from mutation
by the agent’s tools.
This variable is meant for this specific use case.

### Nested Pi sessions

When Sandburg is loaded in a top-level Pi process,
it also tries to load itself into ordinary nested Pi sessions created by trusted extensions.
This covers child Pi processes launched as `pi`
and common in-process sessions created through Pi’s SDK.
It is best-effort compatibility for non-malicious extensions,
not a boundary against malicious extension code running in the same Pi process.
The `/sandburg` command reports whether these propagation mechanisms are active.

Nested-session protection is best-effort.
It covers common child Pi sessions,
but some custom extension or SDK setups may need separate review.
Check `/sandburg` if nested-session behavior matters for your workflow.

## Recommended Sandkasten + Sandburg setup

Consult [Sandkasten documentation](https://github.com/grothesque/sandkasten#readme)
for details.

In addition to installing Sandburg as described above,
set up Sandkasten as follows:

1. Install `skn`, the Sandkasten shell script, somewhere in `PATH`.
2. Configure the basic Sandkasten policy by setting the `SKN_PATH_CHECK`
   and `SKN_RO_BINDS` environment variables.
3. Verify the basic Sandkasten policy by running `skn true +S`.
   (`true` is used here because it has no side effects; the command itself is not important.)
4. From a project directory, simulate running Pi in the sandbox by running Bash instead:
   `skn bash +W.`
   Confirm that files are accessible or hidden as desired.
5. Define a shell alias, script, or shell function for launching Pi
   within Sandkasten.
   For example:
   ```sh
   pi_agent_dir="$HOME/.pi/agent"
   mkdir -p "$pi_agent_dir/bin"

   alias pi='skn /path/to/pi \
     +W "$pi_agent_dir" \
     +T "$pi_agent_dir/bin" \
     +N'
   ```

The alias above exposes `~/.pi/agent/bin`
as a transient writable overlay.
The helper files written there by Sandburg are visible only to that Pi process
while it is running.
The `+N` option grants network access to Pi itself,
so that it can communicate with the model provider.
If `/path/to/pi` or Pi’s package root is not otherwise readable
inside the outer sandbox, bind the needed path read-only with `SKN_RO_BINDS` or `+R`.

### Usage

The sandboxed Pi can now be invoked simply by running `pi`.
It accepts all of Pi’s regular command-line arguments.
For example:
```sh
pi --help
pi --model some_model
echo "1 + 1" | pi
```

In addition, it accepts special Sandkasten options that begin with `+`
followed by a capital letter.
For example:
```sh
pi +S            # Show the sandbox setup, including bwrap invocation.
pi +W.           # Allow writes to the current directory.
pi +T. +W build  # Discard cwd writes except in build.
```

By default, the Pi process can only read paths listed in `SKN_RO_BINDS`
and can only write to its agent directory.
No other write permissions are granted by default.

Sandkasten and Pi options can be mixed,
but Sandkasten options must come first:
```sh
pi +W. --model other_model
```

Despite that restriction, shell aliases can still include Pi options
by using Sandkasten’s special `+A` option:
```sh
alias pi-other='pi +A --model +A other_model'
```

### Additional recommendations

To reduce the risk of starting Pi without its outer sandbox,
keep the npm root `bin` directory out of `PATH`
and launch Pi only through the Sandkasten wrapper or alias.

For some protection against npm supply-chain attacks,
install or update Pi (and other npm software) from inside a suitably restricted Sandkasten session,
for example:
```sh
skn bash +N +W ~/.npm +W ~/.npm-global +R ~/.npmrc
```

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
- `ls` and `find` do not need to be reimplemented since they neither read files nor access the network.
  Sandburg verifies that they remain Pi’s ordinary built-in tools.

For nested sessions,
Sandburg also installs best-effort propagation hooks as described above.
On each reload, Sandburg ensures that the core built-in-tool contract is valid.
If it is not, it disables all tools and warns the user.
Run `/sandburg` after launch or `/reload` to inspect helper setup,
protected paths, outer-sandbox signals, active extra extension tools,
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
