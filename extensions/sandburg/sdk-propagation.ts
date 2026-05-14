// Best-effort propagation for Pi SDK-created in-process sessions.
//
// This compatibility bridge covers nested sessions that use the same Pi SDK
// module instance, call DefaultResourceLoader.reload(), and later bind loaded
// extensions so Sandburg's session_start handlers can replace tools. It cannot
// cover custom resource loaders, different/bundled SDK copies, loaders reloaded
// before Sandburg is loaded, or hosts that never bind extensions. Long term,
// mandatory containment-extension propagation belongs in Pi itself.
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { join, resolve } from "path";
import {
	getSandburgRuntimeState,
	hasActiveSandburgSession,
	setSdkPropagationState,
	type SandburgRuntimeState,
} from "./runtime-state.js";

const RELOAD_PATCH = Symbol.for("sandburg.DefaultResourceLoader.reload.v1");

type ReloadFunction = (...args: unknown[]) => Promise<unknown>;

type PatchedResourceLoaderPrototype = {
	reload: ReloadFunction;
	[RELOAD_PATCH]?: { originalReload: ReloadFunction };
};

type ResourceLoaderWithAdditionalExtensions = {
	additionalExtensionPaths?: unknown;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function comparablePath(path: string): string {
	const resolved = resolve(path);
	try {
		return existsSync(resolved) ? realpathSync(resolved) : resolved;
	} catch {
		return resolved;
	}
}

function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

function directoryEntryResolvesToSandburgExtension(path: string, sandburgExtensionPath: string): boolean {
	try {
		if (!statSync(path).isDirectory()) return false;
	} catch {
		return false;
	}

	if (samePath(join(path, "index.ts"), sandburgExtensionPath) || samePath(join(path, "index.js"), sandburgExtensionPath)) {
		return true;
	}

	try {
		const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8")) as { pi?: { extensions?: unknown } };
		if (!Array.isArray(pkg.pi?.extensions)) return false;
		return pkg.pi.extensions.some(
			(entry) => typeof entry === "string" && samePath(resolve(path, entry), sandburgExtensionPath),
		);
	} catch {
		return false;
	}
}

function entryResolvesToSandburgExtension(path: string, sandburgExtensionPath: string): boolean {
	return samePath(path, sandburgExtensionPath) || directoryEntryResolvesToSandburgExtension(path, sandburgExtensionPath);
}

function withSandburgExtensionFirst(paths: string[], sandburgExtensionPath: string): string[] {
	return [
		sandburgExtensionPath,
		...paths.filter((path) => !entryResolvesToSandburgExtension(path, sandburgExtensionPath)),
	];
}

function currentAdditionalExtensionPaths(loader: ResourceLoaderWithAdditionalExtensions): string[] {
	if (!Array.isArray(loader.additionalExtensionPaths)) return [];
	return loader.additionalExtensionPaths.filter((entry): entry is string => typeof entry === "string");
}

export function setupSdkPropagation(runtimeState: SandburgRuntimeState) {
	if (runtimeState.propagationDisable.disabled.has("sdk")) {
		setSdkPropagationState({ status: "disabled", violations: [] });
		return;
	}

	const sandburgExtensionPath = runtimeState.resolvedSandburgExtensionPath;
	if (!sandburgExtensionPath) {
		setSdkPropagationState({
			status: "unavailable",
			violations: ["resolved Sandburg extension path is not initialized"],
		});
		return;
	}

	try {
		const prototype = DefaultResourceLoader.prototype as unknown as PatchedResourceLoaderPrototype;
		if (prototype[RELOAD_PATCH]) {
			setSdkPropagationState({ status: "active", violations: [] });
			return;
		}

		const originalReload = prototype.reload;
		prototype.reload = async function sandburgReloadWithExtensionPropagation(this: unknown, ...args: unknown[]) {
			const currentState = getSandburgRuntimeState();
			const currentSandburgExtensionPath = currentState.resolvedSandburgExtensionPath;
			if (
				!currentState.propagationDisable.disabled.has("sdk") &&
				currentSandburgExtensionPath &&
				hasActiveSandburgSession(currentState)
			) {
				const loader = this as ResourceLoaderWithAdditionalExtensions;
				loader.additionalExtensionPaths = withSandburgExtensionFirst(
					currentAdditionalExtensionPaths(loader),
					currentSandburgExtensionPath,
				);
			}
			return originalReload.apply(this, args);
		};
		prototype[RELOAD_PATCH] = { originalReload };

		setSdkPropagationState({ status: "active", violations: [] });
	} catch (error) {
		setSdkPropagationState({
			status: "unavailable",
			violations: [`could not patch DefaultResourceLoader.reload: ${errorMessage(error)}`],
		});
	}
}
