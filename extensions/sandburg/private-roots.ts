// Sandburg private state roots and path-policy helpers
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";

export const SANDBURG_PRIVATE_PATHS_ENV = "SANDBURG_PRIVATE_PATHS";
export const SANDBURG_AGENT_DIR_ENV = "SANDBURG_AGENT_DIR";

export const AGENT_DIR = resolve(getAgentDir());
export const AGENT_BIN_DIR = join(AGENT_DIR, "bin");
export const TOOL_SANDBOX_RUNNER_PATH = join(AGENT_BIN_DIR, "sandburg-tool-sandbox");
export const RG_WRAPPER_PATH = join(AGENT_BIN_DIR, "rg");
export const PI_WRAPPER_PATH = join(AGENT_BIN_DIR, "pi");
export const JITI_CACHE_DIR = "/tmp/jiti";

export const SANDBURG_PRIVATE_PATHS_VALUE = process.env[SANDBURG_PRIVATE_PATHS_ENV] ?? "";
export const EXTRA_PRIVATE_PATHS = SANDBURG_PRIVATE_PATHS_VALUE === "" ? [] : SANDBURG_PRIVATE_PATHS_VALUE.split(":");
export const DEFAULT_PRIVATE_ROOTS = [AGENT_DIR, AGENT_BIN_DIR, JITI_CACHE_DIR];
export const PRIVATE_ROOTS = [...DEFAULT_PRIVATE_ROOTS, ...EXTRA_PRIVATE_PATHS];

export function isWithinRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Canonicalize for policy checks while preserving nonexistent path suffixes.
 * Resolves symlinks component-by-component, including dangling final symlinks.
 */
export function canonicalPathForPolicy(absPath: string, seenSymlinks = new Set<string>()): string {
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

function uniqueStrings(values: Iterable<string>): string[] {
	return Array.from(new Set(values));
}

export function privateRootsForPolicy(): string[] {
	return uniqueStrings(PRIVATE_ROOTS.flatMap((root) => [root, canonicalPathForPolicy(root)]));
}

export function isPrivatePath(rawPath: string, canonicalPath: string): boolean {
	return privateRootsForPolicy().some(
		(root) => isWithinRoot(rawPath, root) || isWithinRoot(canonicalPath, root),
	);
}

export function getExtraPrivatePathViolations(): string[] {
	return EXTRA_PRIVATE_PATHS.flatMap((path, index) => {
		const label = `${SANDBURG_PRIVATE_PATHS_ENV} entry #${index + 1}`;
		if (path === "") return [`${label} is empty.`];
		if (!isAbsolute(path)) return [`${label} is not absolute: ${path}`];
		if (!existsSync(path)) return [`${label} does not exist: ${path}`];
		try {
			if (!statSync(path).isDirectory()) return [`${label} is not a directory: ${path}`];
			if (realpathSync(path) === "/") return [`${label} must not be /.`];
		} catch (error) {
			return [`${label} cannot be inspected: ${path}: ${error instanceof Error ? error.message : String(error)}`];
		}
		return [];
	});
}
