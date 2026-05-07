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
Sandburg needs to write a ripgrep wrapper shell script named `rg` in that directory,
along with a second shell script named `sandburg-tool-sandbox`.
If an `rg` downloaded by Pi is already there
Sandburg will report a setup violation and disable tools.

(These two helper scripts are recreated automatically and may be removed
when Pi is not running.
With the recommended Sandkasten setup,
they live only inside Pi’s temporary sandbox.)

### Installing Sandburg

Copy or link the extension directory `sandburg` (the one containing `index.ts`)
into a Pi extension directory, for example `$HOME/.pi/agent/extensions`.

It is highly recommended to launch Pi within an outer `bwrap` sandbox.
The recommended setup using Sandkasten is described below.

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
   pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   alias pi='skn /path/to/pi +W "$pi_agent_dir" +T "$pi_agent_dir/bin" +N'
   ```

The alias above exposes `~/.pi/agent/bin`
as a transient writable overlay.
The helper files written there by Sandburg are visible only to that Pi process
while it is running.
The `+N` option grants network access to Pi itself,
so that it can communicate with the model provider.

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
pi +S              # Show the sandbox setup, including the full bwrap command line, then exit.
pi +W.             # Launch Pi with write access to the current directory.
pi +T. +W./build   # Expose cwd as a tmp-overlay; allow writes to existing directory ./build.
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
# This uses the basic pi alias defined above.
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
skn bash +N +W ~/.npm +W ~/.npmroot +R ~/.npmrc
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

On each reload, Sandburg ensures that this tool contract is valid.
If it is not, it disables all tools and warns the user.

Caveat: Since Sandburg installs its managed `rg` wrapper for use by Pi’s built-in grep tool,
a user command such as `! rg ...` will typically resolve to that wrapper
and run ripgrep inside Sandburg’s tool sandbox.
This mainly affects searches of Sandburg-protected paths such as Pi agent state.
To run ripgrep exactly as an unrestricted user command, invoke the real binary directly,
for example `/usr/bin/rg`, adjusted for your system.

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
The `/sandburg` command lists any such additional tools that are active.
