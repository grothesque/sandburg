// Sandburg status report generation for the /sandburg command
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { isAbsolute } from "path";
import {
	ACTIVE_MARKER,
	AGENT_DIR,
	EXTRA_RO_PATHS,
	JITI_CACHE_DIR,
	checkSandburgHelpers,
} from "./helpers.js";
import {
	SANDBURG_DISABLE_PROPAGATION_ENV,
	describeRealPiInvocation,
	getSandburgRuntimeState,
} from "./runtime-state.js";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

type MountInfoEntry = {
	mountPoint: string;
	root: string;
	options: string[];
	fsType: string;
};

const VIRTUAL_FILESYSTEM_TYPES = new Set([
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
]);

const SANDBURG_TOOL_NAMES = ["bash", "grep", "read", "write", "edit"];
const SANDBURG_REDEFINED_TOOL_NAMES = ["bash", "read", "write", "edit"];
const BUILTIN_DISCOVERY_TOOL_NAMES = ["find", "ls"];
const BUILTIN_TOOL_NAMES = ["grep", ...BUILTIN_DISCOVERY_TOOL_NAMES];
const KNOWN_TOOL_NAME_SET = new Set([...SANDBURG_TOOL_NAMES, ...BUILTIN_DISCOVERY_TOOL_NAMES]);

// Pi tool-model assumptions relied on by the setup check below:
//
// - Pi starts with built-in tools in the registry.
// - An extension can replace a built-in tool by registering a tool with the
//   same name.
// - Extension tools are de-duplicated by name in extension load order: the
//   first extension owning a registered tool name wins among extension tools.
// - Therefore, once sandburg’s replacements for bash/read/write/edit are the
//   effective tools after load/reload, later-loaded extensions cannot silently
//   replace them during the same extension runtime.
// - A previously loaded extension that deliberately registers a protected name
//   later at runtime is trusted dynamic extension behavior; sandburg does not
//   continuously police that with per-call setup checks.
// - Newly introduced tools with different names may still appear and become
//   active; those are user-controlled extensions, not sandburg setup failures.
//   We warn about them at load/reload and in /sandburg status.
//
// If Pi’s tool registration or override semantics change, re-audit this file
// and index.ts before relying on a startup setup check being stable for the
// whole session.

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

function isReadOnlyMount(mount: MountInfoEntry): boolean {
	return mount.options.includes("ro");
}

function isVirtualMount(mount: MountInfoEntry): boolean {
	return VIRTUAL_FILESYSTEM_TYPES.has(mount.fsType);
}

function isZeroCapability(value: string | undefined): boolean {
	return value !== undefined && /^0+$/.test(value);
}

function isInitialUserNamespaceMap(map: string | undefined): boolean {
	return /^\s*0\s+0\s+4294967295\s*$/.test(map?.trim() ?? "");
}

function isBroadHostExposureTarget(mountPoint: string): boolean {
	return (
		mountPoint === "/" ||
		mountPoint === "/home" ||
		/^\/home\/[^/]+$/.test(mountPoint) ||
		mountPoint === "/etc" ||
		mountPoint === "/var"
	);
}

function isSandburgToolSource(tool: ToolInfo): boolean {
	const path = tool.sourceInfo.path.replace(/\\/g, "/");
	return (
		path.endsWith("/sandburg") ||
		path === "sandburg" ||
		path.endsWith("/sandburg/index.ts") ||
		path === "sandburg/index.ts"
	);
}

function isBuiltinToolSource(tool: ToolInfo, name: string): boolean {
	return tool.sourceInfo.source === "builtin" && tool.sourceInfo.path === `<builtin:${name}>`;
}

function appendPathList(lines: string[], label: string, paths: string[]) {
	if (paths.length === 0) {
		lines.push(`- ${label}: (none)`);
		return;
	}

	lines.push(`- ${label}:`);
	for (const path of paths) lines.push(`  - ${path}`);
}

function sortedToolNames(names: Iterable<string>, order?: string[]): string[] {
	const orderIndex = new Map(order?.map((name, index) => [name, index]) ?? []);
	return Array.from(new Set(names)).sort(
		(a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
	);
}

export type SandburgCheckStatus = {
	valid: boolean;
	violations: string[];
};

export type SandburgStatus = {
	text: string;
	severity: "success" | "warning";
};

function describeToolSource(tool: ToolInfo): string {
	const path = tool.sourceInfo.path;
	switch (tool.sourceInfo.source) {
		case "auto":
			return `auto-loaded extension: ${path}`;
		case "local":
			return `local extension: ${path}`;
		case "cli":
			return `CLI extension: ${path}`;
		case "builtin":
			return `Pi built-in tool: ${path}`;
		default:
			return `${tool.sourceInfo.source} extension: ${path}`;
	}
}

function toolByName(pi: ExtensionAPI): Map<string, ToolInfo> {
	return new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
}

function getExtraRoPathViolations(): string[] {
	return EXTRA_RO_PATHS.flatMap((path, index) => {
		const label = `SANDBURG_RO_PATHS entry #${index + 1}`;
		if (path === "") return [`${label} is empty.`];
		if (!isAbsolute(path)) return [`${label} is not absolute: ${path}`];
		if (!existsSync(path)) return [`${label} does not exist: ${path}`];
		return [];
	});
}

export function getAdditionalActiveToolNames(pi: ExtensionAPI): string[] {
	const allTools = pi.getAllTools();
	const enabledToolNames = new Set(pi.getActiveTools());
	return sortedToolNames(
		allTools.filter((tool) => enabledToolNames.has(tool.name) && !KNOWN_TOOL_NAME_SET.has(tool.name)).map((tool) => tool.name),
	);
}

export function checkSandburgSetup(pi: ExtensionAPI, setupViolations: string[] = []): SandburgCheckStatus {
	const tools = toolByName(pi);
	const violations = new Set<string>(setupViolations);

	if (process.env.SANDBURG_ACTIVE !== ACTIVE_MARKER) {
		violations.add("sandburg extension marker is not active.");
	}
	for (const violation of checkSandburgHelpers()) violations.add(violation);
	for (const violation of getExtraRoPathViolations()) violations.add(violation);

	for (const name of SANDBURG_REDEFINED_TOOL_NAMES) {
		const tool = tools.get(name);
		if (tool && !isSandburgToolSource(tool)) {
			violations.add(`${name}: expected sandburg-managed tool; found ${describeToolSource(tool)}.`);
		}
	}

	for (const name of BUILTIN_TOOL_NAMES) {
		const tool = tools.get(name);
		if (tool && !isBuiltinToolSource(tool, name)) {
			violations.add(`${name}: expected Pi built-in tool; found ${describeToolSource(tool)}.`);
		}
	}

	const violationList = [...violations];
	return { valid: violationList.length === 0, violations: violationList };
}

export function buildSandburgStatus(pi: ExtensionAPI, sandburgCheck = checkSandburgSetup(pi), toolsDisabledUntilReload = false): SandburgStatus {
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
	const namespaceSandboxDetected =
		userNamespaceMapped || noNewPrivs || capsNone || (rootMount?.fsType === "tmpfs" && rootMount.root !== "/");
	const sortedNonVirtualMounts = mounts
		.filter((mount) => !isVirtualMount(mount))
		.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
	const hostWritableMounts = sortedNonVirtualMounts
		.filter((mount) => mount.fsType !== "overlay" && !isReadOnlyMount(mount))
		.map((mount) => mount.mountPoint);
	const broadHostExposures = sortedNonVirtualMounts
		.filter((mount) => isBroadHostExposureTarget(mount.mountPoint))
		.map((mount) => {
			const mode = mount.fsType === "overlay" ? "tmp overlay" : isReadOnlyMount(mount) ? "read-only" : "writable";
			return `${mount.mountPoint} (${mode})`;
		});
	const additionalActiveTools = getAdditionalActiveToolNames(pi);
	const runtimeState = getSandburgRuntimeState();
	const unknownDisableTokens = runtimeState.propagationDisable.unknownTokens;
	const disabledPropagation = [...runtimeState.propagationDisable.disabled].sort();
	const warnings = [
		!sandburgCheck.valid &&
			(toolsDisabledUntilReload
				? "Sandburg setup is invalid, so all tools are disabled until /reload."
				: "Sandburg setup is invalid."),
		sandburgCheck.valid && toolsDisabledUntilReload && "All tools are disabled until /reload.",
		additionalActiveTools.length > 0 &&
			`Additional tools are active outside the sandburg core tool set: ${additionalActiveTools.join(", ")}`,
		unknownDisableTokens.length > 0 &&
			`Unknown ${SANDBURG_DISABLE_PROPAGATION_ENV} token(s): ${unknownDisableTokens.join(", ")}`,
		!namespaceSandboxDetected && "No outer sandbox for the pi process detected!",
		broadHostExposures.length > 0 && "Broad host exposure detected!",
	].filter(Boolean) as string[];
	const protectedPaths = [AGENT_DIR, JITI_CACHE_DIR, ...EXTRA_RO_PATHS];

	const lines = [warnings.length === 0 ? "Sandburg: OK" : "Check sandburg setup"];
	if (warnings.length > 0) {
		lines.push("");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}

	if (sandburgCheck.violations.length > 0) {
		lines.push("", "Sandburg setup violations");
		for (const violation of sandburgCheck.violations) lines.push(`- ${violation}`);
	}

	lines.push("", "Outer sandbox for the pi process");
	if (namespaceSandboxDetected) {
		appendPathList(lines, "host-writable mounts", hostWritableMounts);
		if (broadHostExposures.length > 0) appendPathList(lines, "broad host exposure", broadHostExposures);
	} else if (broadHostExposures.length > 0) {
		appendPathList(lines, "broad host exposure", broadHostExposures);
	} else {
		lines.push("- not detected");
	}

	lines.push(
		"",
		"Agent tool restrictions",
		"- network disabled",
		"- protected paths:",
		...protectedPaths.map((path) => `  - ${path}`),
	);

	lines.push(
		"",
		"Sandburg process state",
		`- propagated extension path: ${runtimeState.resolvedSandburgExtensionPath ?? "(not initialized)"}`,
		`- real Pi invocation: ${describeRealPiInvocation(runtimeState.realPiInvocation)}`,
		`- propagation disabled: ${disabledPropagation.length > 0 ? disabledPropagation.join(", ") : "(none)"}`,
	);

	return { text: lines.join("\n"), severity: warnings.length === 0 ? "success" : "warning" };
}
