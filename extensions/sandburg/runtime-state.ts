// Process-global Sandburg runtime state and propagation configuration
import { existsSync, realpathSync } from "fs";
import { fileURLToPath } from "url";

export const SANDBURG_DISABLE_PROPAGATION_ENV = "SANDBURG_DISABLE_PROPAGATION";
export const SANDBURG_EXTENSION_PATH_ENV = "SANDBURG_EXTENSION_PATH";

export type PropagationDisableToken = "pi-wrapper" | "sdk" | "all";
export type PropagationMechanism = Exclude<PropagationDisableToken, "all">;

export type PiWrapperPropagationState = {
	status: "not-started" | "installed" | "disabled" | "unavailable";
	path?: string;
	violations: string[];
};

export type SdkPropagationState = {
	status: "not-started" | "active" | "disabled" | "unavailable";
	violations: string[];
};

type EnvVarOwnership = {
	originalValue: string | undefined;
	currentValue: string;
	owners: Map<symbol, string>;
};

export type EnvOwnershipHandle = {
	release(): void;
};

export type ActiveSessionHandle = {
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
	propagationDisable: PropagationDisableState;
	piWrapperPropagation: PiWrapperPropagationState;
	sdkPropagation: SdkPropagationState;
	envVars: Map<string, EnvVarOwnership>;
	activeSessionOwners: Set<symbol>;
};

const RUNTIME_STATE_SYMBOL = Symbol.for("sandburg.runtime-state.v1");
const RECOGNIZED_DISABLE_TOKENS = new Set<PropagationDisableToken>(["pi-wrapper", "sdk", "all"]);
const PROPAGATION_MECHANISMS: PropagationMechanism[] = ["pi-wrapper", "sdk"];

function createDefaultDisableState(): PropagationDisableState {
	return { tokens: new Set(), disabled: new Set(), unknownTokens: [] };
}

function createPiWrapperPropagationState(): PiWrapperPropagationState {
	return { status: "not-started", violations: [] };
}

function createSdkPropagationState(): SdkPropagationState {
	return { status: "not-started", violations: [] };
}

function createRuntimeState(): SandburgRuntimeState {
	return {
		version: 1,
		propagationDisable: createDefaultDisableState(),
		piWrapperPropagation: createPiWrapperPropagationState(),
		sdkPropagation: createSdkPropagationState(),
		envVars: new Map(),
		activeSessionOwners: new Set(),
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

export function setSdkPropagationState(update: SdkPropagationState) {
	getSandburgRuntimeState().sdkPropagation = update;
}

export function claimActiveSandburgSession(): ActiveSessionHandle {
	const state = getSandburgRuntimeState();
	const owner = Symbol("sandburg-active-session-owner");
	let released = false;
	state.activeSessionOwners.add(owner);

	return {
		release() {
			if (released) return;
			released = true;
			state.activeSessionOwners.delete(owner);
		},
	};
}

export function hasActiveSandburgSession(state = getSandburgRuntimeState()): boolean {
	return state.activeSessionOwners.size > 0;
}

export function __resetSandburgRuntimeStateForTests() {
	const globalRecord = globalThis as typeof globalThis & { [RUNTIME_STATE_SYMBOL]?: SandburgRuntimeState };
	delete globalRecord[RUNTIME_STATE_SYMBOL];
}
