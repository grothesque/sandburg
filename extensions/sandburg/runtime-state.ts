// Process-global Sandburg runtime state and propagation configuration
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const SANDBURG_DISABLE_PROPAGATION_ENV = "SANDBURG_DISABLE_PROPAGATION";
export const SANDBURG_REAL_PI_COMMAND_ENV = "SANDBURG_REAL_PI_COMMAND";
export const SANDBURG_REAL_PI_ARGS_JSON_ENV = "SANDBURG_REAL_PI_ARGS_JSON";
export const SANDBURG_EXTENSION_PATH_ENV = "SANDBURG_EXTENSION_PATH";
export const SANDBURG_PROPAGATED_CHILD_ENV = "SANDBURG_PROPAGATED_CHILD";

export type PropagationDisableToken = "pi-wrapper" | "sdk" | "argv1" | "all";
export type PropagationMechanism = Exclude<PropagationDisableToken, "all">;

export type RealPiInvocation = {
	command: string;
	argsPrefix: string[];
};

type RealPiInvocationCapture =
	| { status: "captured"; invocation: RealPiInvocation }
	| { status: "unavailable"; reason: string };

export type PiWrapperPropagationState = {
	status: "not-started" | "installed" | "disabled" | "unavailable";
	path?: string;
	violations: string[];
	pathUpdated: boolean;
	firstPiOnPath?: string;
	firstPiOnPathManaged?: boolean;
};

type EnvVarOwnership = {
	originalValue: string | undefined;
	currentValue: string;
	owners: Map<symbol, string>;
};

export type EnvOwnershipHandle = {
	release(): void;
};

export type PropagationDisableState = {
	tokens: Set<PropagationDisableToken>;
	disabled: Set<PropagationMechanism>;
	unknownTokens: string[];
};

export type SandburgRuntimeState = {
	version: 1;
	resolvedSandburgExtensionPath?: string;
	realPiInvocation?: RealPiInvocation;
	realPiInvocationUnavailableReason?: string;
	propagationDisable: PropagationDisableState;
	piWrapperPropagation: PiWrapperPropagationState;
	envVars: Map<string, EnvVarOwnership>;
};

const RUNTIME_STATE_SYMBOL = Symbol.for("sandburg.runtime-state.v1");
const RECOGNIZED_DISABLE_TOKENS = new Set<PropagationDisableToken>(["pi-wrapper", "sdk", "argv1", "all"]);
const PROPAGATION_MECHANISMS: PropagationMechanism[] = ["pi-wrapper", "sdk", "argv1"];

function createDefaultDisableState(): PropagationDisableState {
	return { tokens: new Set(), disabled: new Set(), unknownTokens: [] };
}

function createPiWrapperPropagationState(): PiWrapperPropagationState {
	return { status: "not-started", violations: [], pathUpdated: false };
}

function createRuntimeState(): SandburgRuntimeState {
	return {
		version: 1,
		propagationDisable: createDefaultDisableState(),
		piWrapperPropagation: createPiWrapperPropagationState(),
		envVars: new Map(),
	};
}

export function getSandburgRuntimeState(): SandburgRuntimeState {
	const globalRecord = globalThis as typeof globalThis & { [RUNTIME_STATE_SYMBOL]?: SandburgRuntimeState };
	globalRecord[RUNTIME_STATE_SYMBOL] ??= createRuntimeState();
	return globalRecord[RUNTIME_STATE_SYMBOL];
}

function realpathIfPossible(path: string): string {
	try {
		return existsSync(path) ? realpathSync(path) : path;
	} catch {
		return path;
	}
}

function extensionPathFromImportMetaUrl(importMetaUrl: string): string {
	try {
		return realpathIfPossible(fileURLToPath(importMetaUrl));
	} catch {
		return importMetaUrl;
	}
}

function readPackageNameForCli(cliPath: string): string | undefined {
	try {
		const packageJsonPath = join(dirname(dirname(cliPath)), "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
		return typeof packageJson.name === "string" ? packageJson.name : undefined;
	} catch {
		return undefined;
	}
}

function captureRealPiInvocation(): RealPiInvocationCapture {
	if (process.env.PI_CODING_AGENT !== "true") {
		return { status: "unavailable", reason: "PI_CODING_AGENT=true is not set" };
	}

	const argv1 = process.argv[1];
	if (!argv1) {
		return { status: "unavailable", reason: "process.argv[1] is not set" };
	}

	const resolvedArgv1 = realpathIfPossible(argv1);
	if (!resolvedArgv1.replace(/\\/g, "/").endsWith("/dist/cli.js")) {
		return { status: "unavailable", reason: `process.argv[1] is not Pi's dist/cli.js: ${resolvedArgv1}` };
	}

	const packageName = readPackageNameForCli(resolvedArgv1);
	if (packageName !== "@earendil-works/pi-coding-agent") {
		return { status: "unavailable", reason: `process.argv[1] is not from @earendil-works/pi-coding-agent: ${resolvedArgv1}` };
	}

	return {
		status: "captured",
		invocation: {
			command: process.execPath,
			argsPrefix: [resolvedArgv1],
		},
	};
}

export function parsePropagationDisableTokens(value: string | undefined): PropagationDisableState {
	const tokens = new Set<PropagationDisableToken>();
	const unknownTokens: string[] = [];
	for (const rawToken of value?.split(",") ?? []) {
		const token = rawToken.trim();
		if (!token) continue;
		if (RECOGNIZED_DISABLE_TOKENS.has(token as PropagationDisableToken)) {
			tokens.add(token as PropagationDisableToken);
		} else {
			unknownTokens.push(token);
		}
	}

	const disabled = new Set<PropagationMechanism>();
	if (tokens.has("all")) {
		for (const mechanism of PROPAGATION_MECHANISMS) disabled.add(mechanism);
	} else {
		for (const mechanism of PROPAGATION_MECHANISMS) {
			if (tokens.has(mechanism)) disabled.add(mechanism);
		}
	}

	return { tokens, disabled, unknownTokens };
}

export function initializeSandburgRuntime(extensionImportMetaUrl: string): SandburgRuntimeState {
	const state = getSandburgRuntimeState();
	state.resolvedSandburgExtensionPath ??= extensionPathFromImportMetaUrl(extensionImportMetaUrl);
	const realPiCapture = captureRealPiInvocation();
	if (realPiCapture.status === "captured") {
		state.realPiInvocation = realPiCapture.invocation;
		delete state.realPiInvocationUnavailableReason;
	} else {
		delete state.realPiInvocation;
		state.realPiInvocationUnavailableReason = realPiCapture.reason;
	}
	state.propagationDisable = parsePropagationDisableTokens(process.env[SANDBURG_DISABLE_PROPAGATION_ENV]);
	return state;
}

function restoreEnvValue(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

export function claimSandburgProcessEnv(values: Record<string, string>): EnvOwnershipHandle {
	const state = getSandburgRuntimeState();
	const owner = Symbol("sandburg-env-owner");
	let released = false;

	for (const [name, value] of Object.entries(values)) {
		let record = state.envVars.get(name);
		if (!record) {
			record = {
				originalValue: process.env[name],
				currentValue: value,
				owners: new Map(),
			};
			state.envVars.set(name, record);
		}
		record.owners.set(owner, value);
		record.currentValue = value;
		process.env[name] = value;
	}

	return {
		release() {
			if (released) return;
			released = true;

			for (const name of Object.keys(values)) {
				const record = state.envVars.get(name);
				if (!record || !record.owners.has(owner)) continue;

				record.owners.delete(owner);
				if (record.owners.size === 0) {
					if (process.env[name] === record.currentValue) {
						restoreEnvValue(name, record.originalValue);
					}
					state.envVars.delete(name);
					continue;
				}

				const remainingValues = Array.from(record.owners.values());
				const nextValue = remainingValues[remainingValues.length - 1];
				if (process.env[name] === record.currentValue) {
					process.env[name] = nextValue;
				}
				record.currentValue = nextValue;
			}
		},
	};
}

export function setPiWrapperPropagationState(update: PiWrapperPropagationState) {
	getSandburgRuntimeState().piWrapperPropagation = update;
}

export function describeRealPiInvocation(invocation: RealPiInvocation | undefined, unavailableReason?: string): string {
	if (!invocation) return unavailableReason ? `(not captured: ${unavailableReason})` : "(not captured)";
	return [invocation.command, ...invocation.argsPrefix].join(" ");
}

export function __resetSandburgRuntimeStateForTests() {
	const globalRecord = globalThis as typeof globalThis & { [RUNTIME_STATE_SYMBOL]?: SandburgRuntimeState };
	delete globalRecord[RUNTIME_STATE_SYMBOL];
}
