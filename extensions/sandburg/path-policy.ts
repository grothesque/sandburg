// Sandburg path guards for Pi’s read, write, and edit tools
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { lstatSync, readlinkSync, realpathSync } from "fs";
import * as os from "os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "path";
import { AGENT_DIR, AUTH_JSON_PATH, EXTRA_RO_PATHS, JITI_CACHE_DIR } from "./helpers.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function isWithinRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Canonicalize for policy checks while preserving nonexistent path suffixes.
 * Resolves symlinks component-by-component, including dangling final symlinks.
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

export function registerGuardedReadToolDefinition(
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

export function registerGuardedMutationToolDefinition(
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
