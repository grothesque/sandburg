// Sandburg path guards for Pi’s read, write, and edit tools
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as os from "os";
import { isAbsolute, resolve } from "path";
import { canonicalPathForPolicy, isPrivatePath } from "./private-roots.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

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
				if (isPrivatePath(rawPath, targetPath)) {
					deny(`Access denied: "${params.path}" is under private Pi/Sandburg state.`);
				}
			}

			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

function guardMutationPath(path: string, localCwd: string) {
	const rawPath = resolveToCwdLikePi(path, localCwd);
	const targetPath = canonicalPathForPolicy(rawPath);
	if (isPrivatePath(rawPath, targetPath)) {
		deny(`Access denied: "${path}" is under private Pi/Sandburg state.`);
	}
}

export function registerGuardedWriteToolDefinition(
	pi: ExtensionAPI,
	definition: ReturnType<typeof createWriteToolDefinition>,
	localCwd: string,
) {
	pi.registerTool({
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			guardMutationPath(params.path, localCwd);
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

export function registerGuardedEditToolDefinition(
	pi: ExtensionAPI,
	definition: ReturnType<typeof createEditToolDefinition>,
	localCwd: string,
) {
	pi.registerTool({
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			guardMutationPath(params.path, localCwd);
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
