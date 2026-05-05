// Sandburg status report generation for the /sandburg command
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import {
	ACTIVE_MARKER,
	AGENT_DIR,
	BWRAP_MARKER,
	BWRAP_PATH,
	EXTRA_RO_PATHS,
	JITI_CACHE_DIR,
	RG_MARKER,
	RG_WRAPPER_PATH,
	isManagedFile,
} from "./helpers.js";

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
const SANDBURG_TOOL_NAME_SET = new Set(SANDBURG_TOOL_NAMES);
const BUILTIN_DISCOVERY_TOOL_NAMES = ["find", "ls"];
const BUILTIN_DISCOVERY_TOOL_NAME_SET = new Set(BUILTIN_DISCOVERY_TOOL_NAMES);

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

function isToolProtectedBySandburg(tool: ToolInfo): boolean {
	if (!SANDBURG_TOOL_NAME_SET.has(tool.name)) return false;
	if (tool.name === "grep") return isBuiltinToolSource(tool, "grep") && isManagedFile(RG_WRAPPER_PATH, RG_MARKER);
	return isSandburgToolSource(tool);
}

function formatList(items: string[]): string {
	return items.length === 0 ? "(none)" : items.join(", ");
}

function appendPathList(lines: string[], label: string, paths: string[]) {
	if (paths.length === 0) {
		lines.push(`- ${label}: (none)`);
		return;
	}

	lines.push(`- ${label}:`);
	for (const path of paths) lines.push(`  - ${path}`);
}

function splitEnabledDisabled(tools: string[], enabledToolNames: Set<string>, order?: string[]) {
	const orderIndex = new Map(order?.map((name, index) => [name, index]) ?? []);
	const sortTools = (names: string[]) =>
		names.sort((a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
	return {
		enabled: sortTools(tools.filter((name) => enabledToolNames.has(name))),
		disabled: sortTools(tools.filter((name) => !enabledToolNames.has(name))),
	};
}

export function buildSandburgStatus(pi: ExtensionAPI): string {
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
	const allTools = pi.getAllTools();
	const enabledToolNames = new Set(pi.getActiveTools());
	const protectedTools = splitEnabledDisabled(
		allTools.filter(isToolProtectedBySandburg).map((tool) => tool.name),
		enabledToolNames,
		SANDBURG_TOOL_NAMES,
	);
	const builtinDiscoveryTools = splitEnabledDisabled(
		allTools
			.filter((tool) => BUILTIN_DISCOVERY_TOOL_NAME_SET.has(tool.name) && isBuiltinToolSource(tool, tool.name))
			.map((tool) => tool.name),
		enabledToolNames,
		BUILTIN_DISCOVERY_TOOL_NAMES,
	);
	const otherTools = splitEnabledDisabled(
		allTools
			.filter(
				(tool) =>
					!isToolProtectedBySandburg(tool) &&
					!(BUILTIN_DISCOVERY_TOOL_NAME_SET.has(tool.name) && isBuiltinToolSource(tool, tool.name)),
			)
			.map((tool) => tool.name),
		enabledToolNames,
	);
	const issues = [
		process.env.SANDBURG_ACTIVE !== ACTIVE_MARKER && "extension marker is not active",
		!isManagedFile(BWRAP_PATH, BWRAP_MARKER) && "inner sandbox helper is missing or unmanaged",
		!isManagedFile(RG_WRAPPER_PATH, RG_MARKER) && "rg wrapper is missing or unmanaged",
		otherTools.enabled.length > 0 && `enabled tools not classified by Sandburg: ${otherTools.enabled.join(", ")}`,
		!namespaceSandboxDetected && "outer namespace sandbox was not detected",
		broadHostExposures.length > 0 && "possible broad host exposure detected",
	].filter(Boolean) as string[];
	const protectedPaths = [AGENT_DIR, JITI_CACHE_DIR, ...EXTRA_RO_PATHS];

	const lines = [
		`Sandburg: ${issues.length === 0 ? "OK" : "CHECK"}`,
		"",
		"Tools protected by Sandburg",
		`- enabled: ${formatList(protectedTools.enabled)}`,
		`- disabled: ${formatList(protectedTools.disabled)}`,
		"",
		"Pi built-in discovery tools",
		`- enabled: ${formatList(builtinDiscoveryTools.enabled)}`,
		`- disabled: ${formatList(builtinDiscoveryTools.disabled)}`,
		"",
		"Other tools",
		`- enabled: ${formatList(otherTools.enabled)}`,
		`- disabled: ${formatList(otherTools.disabled)}`,
		"",
		"Sandburg protections",
		"- Sandburg bash/grep: network disabled",
		"- Sandburg file tools: protected paths denied",
		"- protected paths:",
		...protectedPaths.map((path) => `  - ${path}`),
		"",
		"Outer sandbox for the Pi process",
		`- namespace sandbox: ${namespaceSandboxDetected ? "detected" : "not detected"}`,
	];
	appendPathList(lines, "host-writable mounts", hostWritableMounts);
	if (broadHostExposures.length === 0) {
		lines.push("- broad host exposure: none detected");
	} else {
		appendPathList(lines, "possible broad host exposure detected", broadHostExposures);
	}
	if (issues.length > 0) {
		lines.push("", "Checks");
		for (const issue of issues) lines.push(`- ${issue}`);
	}
	return lines.join("\n");
}
