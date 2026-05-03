/**
 * sandburg.ts: sandbox for agent tools for the pi coding agent
 *
 * This extension is intentionally independent from any outer sandbox wrapper.
 * Used alone, it blocks network access for agent-facing bash/grep subprocesses
 * and protects Pi’s agent state/credentials from Pi’s file tools. Used together
 * with an outer filesystem sandbox such as skn, it provides defense in depth.
 *
 * Security model:
 * - Extensions run as trusted user code. This extension may install/update small
 *   helper scripts in getAgentDir()/bin. That is intentional: Pi’s grep tool
 *   consults this managed-bin location before PATH, so placing the rg wrapper
 *   there covers built-in grep without mutating PATH.
 * - The helper scripts are marker-owned. Unknown pre-existing files are not
 *   overwritten; startup fails with a clear error instead of silently weakening
 *   isolation. Helpers are intentionally left installed across shutdown/reload;
 *   removing them would introduce races and would not handle crashes. The rg
 *   wrapper is transparent when the extension is inactive.
 * - SANDBURG_ACTIVE marks that this extension is active in the Pi process.
 *   SANDBURG_INNER marks commands already running inside sandburg-bwrap. The
 *   rg wrapper uses both so it enters the sandbox exactly once.
 * - Startup self-tests that Pi’s grep tool actually reaches the managed rg
 *   wrapper. If Pi’s lookup behavior changes or another rg wins, startup fails
 *   instead of leaving grep unsandboxed.
 * - sandburg-bwrap is the common inner sandbox for agent-facing subprocesses:
 *   it unshares all namespaces, rebinding Pi agent state read-only, masking
 *   auth.json, hiding /tmp/jiti behind tmpfs, preserving only selected env vars,
 *   and setting SANDBURG_INNER so wrappers are idempotent.
 * - The outer environment may additionally set SANDBURG_RO_PATHS
 *   to a colon-separated list of existing backing-store aliases. The inner
 *   sandbox rebinds those paths read-only, and file mutation tools deny writes
 *   through those roots.
 * - File mutation path checks canonicalize symlinks component-by-component,
 *   including dangling final symlinks, before delegating to Pi’s built-in file
 *   tools. This closes simple symlink-alias bypasses without reimplementing the
 *   tools.
 * - write/edit are marked sequential so they cannot race sibling tool calls in
 *   the same assistant turn. This does not make checks atomic against unrelated
 *   same-user processes, which are outside this threat model.
 * - Hardlink aliases to protected files are not detectable by path
 *   canonicalization. This extension assumes the trusted launch environment and Pi
 *   process are uncompromised.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { spawnSync } from "child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import * as os from "os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";

const SANDBOXED_BASH_DESCRIPTION =
	"Execute a bash command in the current working directory inside a sandbox with network access disabled. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const SANDBOXED_BASH_PROMPT_SNIPPET = "Execute bash commands (ls, grep, find, etc.) inside a sandbox with network access disabled";
const SANDBOXED_BASH_PROMPT_GUIDELINES = [
	"The `bash` tool runs inside a sandbox with network access disabled. Commands that require network access will fail, including downloading files, fetching from package registries, git fetch/pull, and similar operations.",
	"This deliberate network blocking should never make you work around recommended workflows. Instead, ask the user to run any needed command and say whether you need to see the output. For example, ask the user to run `cargo add` instead of guessing the appropriate version of the dependency and manually adding it to `Cargo.toml`.",
];

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const ACTIVE_MARKER = "sandburg-extension-v1";
const RG_PROBE_MESSAGE = "sandburg-rg-wrapper-probe-hit";
const BWRAP_MARKER = "# sandburg-extension-managed: sandburg-bwrap v1";
const RG_MARKER = "# sandburg-extension-managed: rg-wrapper v1";
const REAL_RG_BASENAME = "rg.sandburg-real";
const AGENT_DIR = resolve(getAgentDir());
const AGENT_BIN_DIR = join(AGENT_DIR, "bin");
const AUTH_JSON_PATH = join(AGENT_DIR, "auth.json");
const BWRAP_PATH = join(AGENT_BIN_DIR, "sandburg-bwrap");
const RG_WRAPPER_PATH = join(AGENT_BIN_DIR, "rg");
const REAL_RG_BACKUP_PATH = join(AGENT_BIN_DIR, REAL_RG_BASENAME);
const JITI_CACHE_DIR = "/tmp/jiti";
const EXTRA_RO_PATHS = (process.env.SANDBURG_RO_PATHS ?? "")
	.split(":")
	.filter(Boolean)
	.map((path) => resolve(path));

const BWRAP_SCRIPT = `#!/usr/bin/env bash
${BWRAP_MARKER}
#
# Generated by the Sandburg Pi extension. Safe to remove when Pi is not using it;
# the extension recreates it on startup. Do not edit in place: if customization is
# needed, change the extension that generated this file.
#
# This is the inner sandbox for agent-facing subprocesses. It is intentionally
# small and contract-based: trusted Pi/extension code supplies the environment,
# and this wrapper constrains the command passed by the agent.

set -euo pipefail

if (($# == 0)); then
    echo "Usage: sandburg-bwrap COMMAND [ARG...]" >&2
    exit 2
fi

: "\${HOME:?sandburg-bwrap: HOME is not set}"
: "\${USER:?sandburg-bwrap: USER is not set}"
: "\${PATH:?sandburg-bwrap: PATH is not set}"
: "\${SANDBURG_ACTIVE:?sandburg-bwrap: SANDBURG_ACTIVE is not set}"
: "\${SANDBURG_AGENT_DIR:?sandburg-bwrap: SANDBURG_AGENT_DIR is not set}"
: "\${SANDBURG_AUTH_PATH:?sandburg-bwrap: SANDBURG_AUTH_PATH is not set}"

home=$HOME
user=$USER
logname=\${LOGNAME:-$user}
inner_path=$PATH
agent_dir=$SANDBURG_AGENT_DIR
auth_path=$SANDBURG_AUTH_PATH
protected_paths=\${SANDBURG_RO_PATHS:-}
term=\${TERM:-xterm-256color}
lang=\${LANG:-C.UTF-8}

if [[ ! -d $agent_dir ]]; then
    echo "sandburg-bwrap: Pi agent directory not found: $agent_dir" >&2
    exit 2
fi

bwrap_args=(
    --unshare-all
    --die-with-parent
    --new-session
    --bind / /
    --dev /dev
    --proc /proc
    --ro-bind "$agent_dir" "$agent_dir"
)

# Extra protected paths are supplied by trusted launch configuration as a
# colon-separated list. Each existing file or directory is rebound read-only so
# agent-facing subprocesses cannot mutate protected Pi state through explicit
# backing-store aliases. Nonexistent paths are ignored because there is nothing
# to rebind; provide existing directory roots when creation should be blocked.
IFS=: read -r -a protected_path_array <<< "$protected_paths"
for path in "\${protected_path_array[@]}"; do
    if [[ -n $path && -e $path ]]; then
        bwrap_args+=(--ro-bind "$path" "$path")
    fi
done

env_args=(
    --clearenv
    --setenv HOME "$home"
    --setenv USER "$user"
    --setenv LOGNAME "$logname"
    --setenv SHELL /bin/sh
    --setenv PATH "$inner_path"
    --setenv TERM "$term"
    --setenv LANG "$lang"
    --setenv SANDBURG_ACTIVE "$SANDBURG_ACTIVE"
    --setenv SANDBURG_INNER 1
    --setenv SANDBURG_AGENT_DIR "$agent_dir"
    --setenv SANDBURG_AUTH_PATH "$auth_path"
)

if [[ -n \${COLORTERM:-} ]]; then
    env_args+=(--setenv COLORTERM "$COLORTERM")
fi

for name in "\${!LC_@}"; do
    env_args+=(--setenv "$name" "\${!name}")
done

if [[ -n $protected_paths ]]; then
    env_args+=(--setenv SANDBURG_RO_PATHS "$protected_paths")
fi

# Mount an empty regular file over auth.json. --ro-bind-data takes an fd, so fd
# 9 is opened from /dev/null at the end of this command.
exec bwrap \
    "\${bwrap_args[@]}" \
    --ro-bind-data 9 "$auth_path" \
    --tmpfs /tmp/jiti \
    "\${env_args[@]}" \
    "$@" 9</dev/null
`;

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rgWrapperScript(realRgPath: string, bwrapPath: string): string {
	return `#!/bin/sh
${RG_MARKER}
#
# Generated by the Sandburg Pi extension. Safe to remove when Pi is not using it;
# the extension recreates it on startup. Do not edit in place: if customization is
# needed, change the extension that generated this file.
#
# This wrapper is intentionally transparent unless the extension is active. Pi's
# grep tool discovers getAgentDir()/bin/rg before searching PATH, so this wrapper
# is the stable interception point for sandboxing grep without depending on PATH
# order. Once inside sandburg-bwrap, SANDBURG_INNER makes the wrapper
# idempotent and prevents recursive sandbox entry.

set -eu

active_marker=${shQuote(ACTIVE_MARKER)}
probe_message=${shQuote(RG_PROBE_MESSAGE)}
real_rg=${shQuote(realRgPath)}
bwrap=${shQuote(bwrapPath)}

# Startup self-test hook used by the extension to verify that Pi's grep tool
# reaches this wrapper. This intentionally writes only to stderr and exits
# before entering the sandbox or touching the filesystem.
if [ "\${SANDBURG_RG_WRAPPER_PROBE:-}" = "$active_marker" ]; then
    echo "$probe_message" >&2
    exit 86
fi

if [ "\${SANDBURG_ACTIVE:-}" != "$active_marker" ] || [ "\${SANDBURG_INNER:-}" = 1 ]; then
    exec "$real_rg" "$@"
fi

exec "$bwrap" "$real_rg" "$@"
`;
}

function fatal(message: string): never {
	throw new Error(
		[
			"Sandburg Pi extension cannot start.",
			message,
			"",
			"Refusing to run without sandbox helpers installed safely.",
			"Inspect the path above. If it is safe to replace, move it aside or delete it, then restart Pi.",
			"If it is an older manually installed Sandburg Pi helper, remove it; this extension will recreate it.",
		].join("\n"),
	);
}

function isManagedFile(path: string, marker: string): boolean {
	try {
		return readFileSync(path, "utf-8").includes(marker);
	} catch {
		return false;
	}
}

function isExecutable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function isScriptFile(path: string): boolean {
	try {
		const real = realpathSync(path);
		const bytes = readFileSync(real).subarray(0, 2).toString("utf-8");
		return bytes === "#!";
	} catch {
		return false;
	}
}

function isRipgrep(path: string): boolean {
	if (!isExecutable(path)) return false;
	const result = spawnSync(path, ["--version"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 3000,
	});
	return result.status === 0 && result.stdout.startsWith("ripgrep ");
}

function isPlainRipgrep(path: string): boolean {
	return !isScriptFile(path) && isRipgrep(path);
}

function writeExecutable(path: string, content: string) {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o755, flag: "wx" });
		chmodSync(tempPath, 0o755);
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function installManagedExecutable(path: string, content: string, marker: string, label: string) {
	if (existsSync(path) && !isManagedFile(path, marker)) {
		fatal(
			[
				`Refusing to replace existing ${label}:`,
				"",
				`  ${path}`,
				"",
				"The file is not managed by this extension.",
			].join("\n"),
		);
	}

	if (!existsSync(path) || readFileSync(path, "utf-8") !== content) {
		writeExecutable(path, content);
	}
	chmodSync(path, 0o755);
}

function pathEntries(pathValue: string): string[] {
	return pathValue.split(":").filter(Boolean);
}

function sameExistingPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

function findRealRgOnPathSkipping(binDir: string): string | undefined {
	for (const dir of pathEntries(process.env.PATH ?? "")) {
		if (!isAbsolute(dir)) continue;
		const candidateDir = resolve(dir);
		if (sameExistingPath(candidateDir, binDir)) continue;

		const candidate = join(candidateDir, "rg");
		if (existsSync(candidate) && isPlainRipgrep(candidate)) {
			return realpathSync(candidate);
		}
	}
	return undefined;
}

function moveExistingRgToBackup() {
	if (isScriptFile(RG_WRAPPER_PATH)) {
		fatal(
			[
				"Refusing to adopt an existing script as real ripgrep:",
				"",
				`  ${RG_WRAPPER_PATH}`,
				"",
				"This extension only adopts plain ripgrep binaries at that path. A script could already be a wrapper, causing recursion or bypass surprises.",
			].join("\n"),
		);
	}

	if (!isPlainRipgrep(RG_WRAPPER_PATH)) {
		fatal(
			[
				"Refusing to replace existing rg helper:",
				"",
				`  ${RG_WRAPPER_PATH}`,
				"",
				"It is not managed by this extension and does not look like a plain ripgrep binary.",
			].join("\n"),
		);
	}

	renameSync(RG_WRAPPER_PATH, REAL_RG_BACKUP_PATH);
}

// Resolve the real ripgrep that the persistent wrapper will delegate to. If a
// previous run already adopted one, keep using it. If Pi's managed-bin rg is an
// unmanaged plain ripgrep binary, adopt it by moving it aside. Unmanaged scripts
// are rejected because they may already be wrappers, which risks recursion or
// hidden policy interactions. PATH fallback deliberately skips getAgentDir()/bin
// and relative entries.
function resolveRealRg(): string {
	if (existsSync(REAL_RG_BACKUP_PATH)) {
		if (!isPlainRipgrep(REAL_RG_BACKUP_PATH)) {
			fatal(
				[
					"The sandbox rg backup exists but is not a plain ripgrep binary:",
					"",
					`  ${REAL_RG_BACKUP_PATH}`,
				].join("\n"),
			);
		}

		if (existsSync(RG_WRAPPER_PATH) && !isManagedFile(RG_WRAPPER_PATH, RG_MARKER)) {
			fatal(
				[
					"The sandbox rg backup exists, but getAgentDir()/bin/rg is an unmanaged file:",
					"",
					`  ${RG_WRAPPER_PATH}`,
					"",
					`Expected the managed wrapper there and real ripgrep at ${REAL_RG_BACKUP_PATH}.`,
				].join("\n"),
			);
		}

		return REAL_RG_BACKUP_PATH;
	}

	if (existsSync(RG_WRAPPER_PATH) && !isManagedFile(RG_WRAPPER_PATH, RG_MARKER)) {
		moveExistingRgToBackup();
		return REAL_RG_BACKUP_PATH;
	}

	const realRg = findRealRgOnPathSkipping(AGENT_BIN_DIR);
	if (!realRg) {
		fatal(
			[
				"No real ripgrep binary was found.",
				"",
				`This extension needs real rg so it can install ${RG_WRAPPER_PATH} as a sandbox wrapper.`,
				`Install ripgrep or ensure rg is available outside ${AGENT_BIN_DIR}, then restart Pi.`,
			].join("\n"),
		);
	}

	return realRg;
}

function installSandboxHelpers() {
	mkdirSync(AGENT_BIN_DIR, { recursive: true });
	installManagedExecutable(BWRAP_PATH, BWRAP_SCRIPT, BWRAP_MARKER, "sandburg-bwrap helper");

	const realRg = resolveRealRg();
	installManagedExecutable(RG_WRAPPER_PATH, rgWrapperScript(realRg, BWRAP_PATH), RG_MARKER, "rg wrapper");

	return { realRg };
}

// Probe Pi's public grep tool factory rather than guessing lookup behavior.
// The generated rg wrapper exits early with a distinctive stderr message when
// this env var is set, so the probe does not write to disk or enter bwrap.
async function verifyPiGrepReachesRgWrapper() {
	const previousProbe = process.env.SANDBURG_RG_WRAPPER_PROBE;
	process.env.SANDBURG_RG_WRAPPER_PROBE = ACTIVE_MARKER;
	try {
		await createGrepToolDefinition(AGENT_BIN_DIR).execute(
			"sandburg-rg-wrapper-probe",
			{
				pattern: "sandburg-wrapper-probe-pattern-that-should-not-matter",
				path: BWRAP_PATH,
				literal: true,
				limit: 1,
			},
			undefined,
			undefined,
			undefined,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes(RG_PROBE_MESSAGE)) return;
		fatal(
			[
				"Pi's grep tool invoked rg, but the managed wrapper probe did not respond as expected.",
				"",
				`  wrapper: ${RG_WRAPPER_PATH}`,
				`  error: ${message}`,
			].join("\n"),
		);
	} finally {
		if (previousProbe === undefined) delete process.env.SANDBURG_RG_WRAPPER_PROBE;
		else process.env.SANDBURG_RG_WRAPPER_PROBE = previousProbe;
	}

	fatal(
		[
			"Pi's grep tool did not invoke the managed rg wrapper:",
			"",
			`  ${RG_WRAPPER_PATH}`,
			"",
			"The bash tool would be sandboxed, but grep would bypass the inner sandbox.",
		].join("\n"),
	);
}

function isWithinRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Canonicalize for policy checks while preserving nonexistent path suffixes.
 *
 * Unlike realpath(existingAncestor), this resolves symlinks component-by-component
 * with lstat(), so a dangling final symlink such as /tmp/link -> /protected/new
 * is still recognized as targeting /protected/new before that target exists.
 */
function canonicalPathForPolicy(absPath: string, seenSymlinks = new Set<string>()): string {
	const normalized = resolve(absPath);
	const { root } = parse(normalized);
	const parts = normalized.slice(root.length).split(sep).filter(Boolean);
	let current = root;

	for (let i = 0; i < parts.length; i++) {
		const candidate = resolve(current, parts[i]);
		try {
			const stat = lstatSync(candidate);
			if (stat.isSymbolicLink()) {
				if (seenSymlinks.has(candidate)) return normalized;
				seenSymlinks.add(candidate);

				const linkTarget = readlinkSync(candidate);
				const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(candidate), linkTarget);
				const remainder = parts.slice(i + 1).join(sep);
				return canonicalPathForPolicy(remainder ? resolve(resolvedTarget, remainder) : resolvedTarget, seenSymlinks);
			}
			current = candidate;
		} catch {
			return resolve(candidate, ...parts.slice(i + 1));
		}
	}

	try {
		return realpathSync(normalized);
	} catch {
		return normalized;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPathLikePi(filePath: string): string {
	const normalized = normalizeAtPrefix(filePath).replace(UNICODE_SPACES, " ");
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}

/** Resolve paths the same way the built-in Pi read/write/edit tools do. */
function resolveToCwdLikePi(filePath: string, cwd: string): string {
	const expanded = expandPathLikePi(filePath);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function deny(message: string): never {
	throw new Error(message);
}

function canonicalAuthPath(): string {
	return canonicalPathForPolicy(AUTH_JSON_PATH);
}

function isJitiCachePath(targetPath: string): boolean {
	return isWithinRoot(targetPath, JITI_CACHE_DIR);
}

function isCredentialPath(targetPath: string): boolean {
	return targetPath === canonicalAuthPath();
}

function isReadProtectedPath(rawPath: string, canonicalPath: string): boolean {
	return (
		isCredentialPath(rawPath) ||
		isCredentialPath(canonicalPath) ||
		isJitiCachePath(rawPath) ||
		isJitiCachePath(canonicalPath)
	);
}

function piMutationProtectedRoots(): string[] {
	const roots = [AGENT_DIR, ...EXTRA_RO_PATHS];
	return roots.flatMap((root) => [root, canonicalPathForPolicy(root)]);
}

function isMutationProtectedPath(rawPath: string, canonicalPath: string): boolean {
	return (
		piMutationProtectedRoots().some(
			(root) => isWithinRoot(rawPath, root) || isWithinRoot(canonicalPath, root),
		) ||
		isJitiCachePath(rawPath) ||
		isJitiCachePath(canonicalPath)
	);
}

function registerGuardedReadToolDefinition(
	pi: ExtensionAPI,
	definition: ReturnType<typeof createReadToolDefinition>,
	localCwd: string,
) {
	pi.registerTool({
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (typeof params?.path === "string") {
				const rawPath = resolveToCwdLikePi(params.path, localCwd);
				const targetPath = canonicalPathForPolicy(rawPath);
				if (isReadProtectedPath(rawPath, targetPath)) {
					deny(`Access denied: "${params.path}" is a protected Pi credential/cache path.`);
				}
			}

			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

function registerGuardedMutationToolDefinition(
	pi: ExtensionAPI,
	definition: ReturnType<typeof createWriteToolDefinition> | ReturnType<typeof createEditToolDefinition>,
	localCwd: string,
) {
	pi.registerTool({
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (typeof params?.path === "string") {
				const rawPath = resolveToCwdLikePi(params.path, localCwd);
				const targetPath = canonicalPathForPolicy(rawPath);
				if (isMutationProtectedPath(rawPath, targetPath)) {
					deny(`Access denied: "${params.path}" is a protected Pi state/cache path.`);
				}
			}

			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

type MountInfoEntry = {
	mountPoint: string;
	root: string;
	options: string[];
	fsType: string;
	source: string;
	superOptions: string[];
};

function readProcFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

function decodeMountField(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function parseMountInfo(content: string | undefined): MountInfoEntry[] {
	if (!content) return [];

	const mounts: MountInfoEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const fields = line.split(" ");
		const separator = fields.indexOf("-");
		if (separator < 0 || fields.length <= separator + 3) continue;
		mounts.push({
			root: decodeMountField(fields[3]),
			mountPoint: decodeMountField(fields[4]),
			options: fields[5].split(","),
			fsType: decodeMountField(fields[separator + 1]),
			source: decodeMountField(fields[separator + 2]),
			superOptions: fields[separator + 3].split(","),
		});
	}
	return mounts;
}

function parseProcStatus(content: string | undefined): Record<string, string> {
	const status: Record<string, string> = {};
	for (const line of content?.split("\n") ?? []) {
		const match = /^(\w+):\s*(.*)$/.exec(line);
		if (match) status[match[1]] = match[2];
	}
	return status;
}

function namespaceLink(name: string): string {
	try {
		return readlinkSync(`/proc/self/ns/${name}`);
	} catch {
		return "unavailable";
	}
}

function isReadOnlyMount(mount: MountInfoEntry): boolean {
	return mount.options.includes("ro");
}

function isVirtualMount(mount: MountInfoEntry): boolean {
	return new Set([
		"autofs",
		"cgroup",
		"cgroup2",
		"configfs",
		"debugfs",
		"devpts",
		"devtmpfs",
		"fusectl",
		"mqueue",
		"proc",
		"pstore",
		"securityfs",
		"sysfs",
		"tmpfs",
		"tracefs",
	]).has(mount.fsType);
}

function isZeroCapability(value: string | undefined): boolean {
	return value !== undefined && /^0+$/.test(value);
}

function isInitialUserNamespaceMap(map: string | undefined): boolean {
	return /^\s*0\s+0\s+4294967295\s*$/.test(map?.trim() ?? "");
}

function formatMount(mount: MountInfoEntry): string {
	const mode = isReadOnlyMount(mount) ? "ro" : "rw";
	const root = mount.root === "/" ? "" : ` root=${mount.root}`;
	return `- ${mount.mountPoint} <- ${mount.source} (${mount.fsType}, ${mode}${root})`;
}

function appendMountList(lines: string[], title: string, mounts: MountInfoEntry[], limit = 30) {
	lines.push("", title);
	if (mounts.length === 0) {
		lines.push("- none");
		return;
	}

	for (const mount of mounts.slice(0, limit)) lines.push(formatMount(mount));
	if (mounts.length > limit) lines.push(`- ... ${mounts.length - limit} more`);
}

function buildSandburgStatus(cwd: string): string {
	const mounts = parseMountInfo(readProcFile("/proc/self/mountinfo"));
	const status = parseProcStatus(readProcFile("/proc/self/status"));
	const uidMap = readProcFile("/proc/self/uid_map")?.trim();
	const gidMap = readProcFile("/proc/self/gid_map")?.trim();
	const rootMount = mounts.find((mount) => mount.mountPoint === "/");
	const noNewPrivs = status.NoNewPrivs === "1";
	const capsNone = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((name) => isZeroCapability(status[name]));
	const userNamespaceMapped =
		(uidMap !== undefined && !isInitialUserNamespaceMap(uidMap)) ||
		(gidMap !== undefined && !isInitialUserNamespaceMap(gidMap));
	const sandboxSignals = [
		userNamespaceMapped && "user namespace mapping",
		noNewPrivs && "NoNewPrivs",
		capsNone && "no capabilities",
		rootMount?.fsType === "tmpfs" && rootMount.root !== "/" && "tmpfs root",
	].filter(Boolean) as string[];
	const sandboxAssessment = sandboxSignals.length > 0 ? `likely yes (${sandboxSignals.join(", ")})` : "unknown/no obvious namespace-sandbox signals";
	const sortedMounts = [...mounts].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
	const readOnlyHostMounts = sortedMounts.filter((mount) => isReadOnlyMount(mount) && !isVirtualMount(mount));
	const writableHostMounts = sortedMounts.filter((mount) => !isReadOnlyMount(mount) && !isVirtualMount(mount));
	const virtualMounts = sortedMounts.filter(isVirtualMount);
	const extraRoPaths = EXTRA_RO_PATHS.length > 0 ? EXTRA_RO_PATHS.join(":") : "none";

	const lines = [
		"Sandburg Pi extension status",
		"",
		"Extension",
		`- active: ${process.env.SANDBURG_ACTIVE === ACTIVE_MARKER ? "yes" : "no"}`,
		`- cwd: ${cwd}`,
		`- agent dir: ${AGENT_DIR}`,
		`- auth path: ${AUTH_JSON_PATH}`,
		`- helper: ${BWRAP_PATH} (${isManagedFile(BWRAP_PATH, BWRAP_MARKER) ? "managed" : "missing/unmanaged"})`,
		`- rg wrapper: ${RG_WRAPPER_PATH} (${isManagedFile(RG_WRAPPER_PATH, RG_MARKER) ? "managed" : "missing/unmanaged"})`,
		`- real rg backup: ${REAL_RG_BACKUP_PATH} (${existsSync(REAL_RG_BACKUP_PATH) ? "present" : "absent"})`,
		`- SANDBURG_RO_PATHS: ${extraRoPaths}`,
		"",
		"Outer namespace sandbox",
		`- assessment: ${sandboxAssessment}`,
		`- namespaces: mnt=${namespaceLink("mnt")}, user=${namespaceLink("user")}, pid=${namespaceLink("pid")}, net=${namespaceLink("net")}, ipc=${namespaceLink("ipc")}, uts=${namespaceLink("uts")}, cgroup=${namespaceLink("cgroup")}`,
		`- uid_map: ${uidMap ?? "unavailable"}`,
		`- gid_map: ${gidMap ?? "unavailable"}`,
		`- NoNewPrivs: ${status.NoNewPrivs ?? "unavailable"}`,
		`- Seccomp: ${status.Seccomp ?? "unavailable"}`,
		`- capabilities: ${capsNone ? "none" : "present or unavailable"}`,
	];

	if (rootMount) lines.push(`- root mount: ${formatMount(rootMount).slice(2)}`);
	appendMountList(lines, "Writable host-backed mounts/binds", writableHostMounts);
	appendMountList(lines, "Read-only host-backed mounts/binds", readOnlyHostMounts);
	appendMountList(lines, "Virtual/tmpfs mounts", virtualMounts, 20);
	return lines.join("\n");
}

export default async function (pi: ExtensionAPI) {
	installSandboxHelpers();
	await verifyPiGrepReachesRgWrapper();

	process.env.SANDBURG_ACTIVE = ACTIVE_MARKER;
	process.env.SANDBURG_AGENT_DIR = AGENT_DIR;
	process.env.SANDBURG_AUTH_PATH = AUTH_JSON_PATH;

	pi.on("session_shutdown", () => {
		if (process.env.SANDBURG_ACTIVE === ACTIVE_MARKER) delete process.env.SANDBURG_ACTIVE;
		if (process.env.SANDBURG_AGENT_DIR === AGENT_DIR) delete process.env.SANDBURG_AGENT_DIR;
		if (process.env.SANDBURG_AUTH_PATH === AUTH_JSON_PATH) delete process.env.SANDBURG_AUTH_PATH;
	});

	let registeredCwd: string | undefined;

	const registerSandboxTools = (localCwd: string) => {
		if (registeredCwd === localCwd) return;
		registeredCwd = localCwd;

		const readDefinition = {
			...createReadToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		const writeDefinition = {
			...createWriteToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		const editDefinition = {
			...createEditToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		// Use ToolDefinition factories when re-registering built-ins in an extension;
		// create*Tool() returns lower-level AgentTool wrappers without Pi renderers.
		const sandboxedBashDefinition = createBashToolDefinition(localCwd, {
			spawnHook: ({ command, cwd, env }) => {
				return {
					command: `exec ${shQuote(BWRAP_PATH)} /bin/bash -c ${shQuote(command)}`,
					cwd,
					env: {
						...env,
						SANDBURG_ACTIVE: ACTIVE_MARKER,
						SANDBURG_AGENT_DIR: AGENT_DIR,
						SANDBURG_AUTH_PATH: AUTH_JSON_PATH,
					},
				};
			},
		});

		Object.assign(sandboxedBashDefinition, {
			name: "bash",
			label: "bash",
			description: SANDBOXED_BASH_DESCRIPTION,
			promptSnippet: SANDBOXED_BASH_PROMPT_SNIPPET,
			promptGuidelines: SANDBOXED_BASH_PROMPT_GUIDELINES,
		});

		pi.registerTool(sandboxedBashDefinition);
		registerGuardedReadToolDefinition(pi, readDefinition, localCwd);
		registerGuardedMutationToolDefinition(pi, writeDefinition, localCwd);
		registerGuardedMutationToolDefinition(pi, editDefinition, localCwd);
	};

	pi.registerCommand("sandburg", {
		description: "Show Sandburg sandbox status",
		handler: async (_args, ctx) => {
			const status = buildSandburgStatus(ctx.cwd);
			if (ctx.hasUI) {
				pi.sendMessage({
					customType: "sandburg-status",
					content: status,
					display: true,
				});
			} else {
				console.log(status);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		registerSandboxTools(ctx.cwd);
	});
}
