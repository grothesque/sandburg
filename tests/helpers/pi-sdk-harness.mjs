// Pi SDK/faux-provider harness for Sandburg tests

import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { findToolEnd, lastAssistantText, toolResultText } from "./events.mjs";
import { HOST_PATH, sandburgExtensionPath } from "./test-env.mjs";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";

function packageDirLooksUsable(path) {
	return !!path && existsSync(join(path, "package.json")) && existsSync(join(path, "dist", "index.js"));
}

function packageDirFromPiBin(path) {
	if (!path || !existsSync(path)) return undefined;

	try {
		const realPath = realpathSync(path);
		const packageDir = dirname(dirname(realPath));
		return packageDirLooksUsable(packageDir) ? packageDir : undefined;
	} catch {
		return undefined;
	}
}

function pathEntries() {
	return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function piPackageDirCandidates() {
	const candidates = [
		process.env.PI_CODING_AGENT_PACKAGE_DIR,
		process.env.PI_PACKAGE_DIR,
		packageDirFromPiBin(process.env.PI_BIN),
		...pathEntries().map((entry) => packageDirFromPiBin(join(entry, "pi"))),
	];

	return [...new Set(candidates.filter(Boolean))];
}

function findPiPackageDir() {
	return piPackageDirCandidates().find(packageDirLooksUsable);
}

// Pi's tool-manager captures getBinDir() at import time. Keep that captured
// directory isolated from the user's real agent dir, then point its bin
// subdirectory at each serial test session's agent-bin directory.
const SDK_IMPORT_AGENT_DIR = mkdtempSync(join(tmpdir(), "sandburg-sdk-import-agent-"));
process.env.PI_CODING_AGENT_DIR = SDK_IMPORT_AGENT_DIR;
process.on("exit", () => {
	rmSync(SDK_IMPORT_AGENT_DIR, { recursive: true, force: true });
});

function pointSdkImportBinDirAt(agentDir) {
	const capturedBinDir = join(SDK_IMPORT_AGENT_DIR, "bin");
	rmSync(capturedBinDir, { recursive: true, force: true });
	symlinkSync(join(agentDir, "bin"), capturedBinDir, "dir");
}

async function importWithFallback(packageName, fallbackPath, help) {
	try {
		return await import(packageName);
	} catch (error) {
		if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
		if (fallbackPath && existsSync(fallbackPath)) {
			return import(pathToFileURL(fallbackPath).href);
		}
		throw new Error(help, { cause: error });
	}
}

const PI_PACKAGE_DIR = findPiPackageDir();

const piSdk = await importWithFallback(
	PI_PACKAGE_NAME,
	PI_PACKAGE_DIR ? join(PI_PACKAGE_DIR, "dist", "index.js") : undefined,
	`Cannot import ${PI_PACKAGE_NAME}. Install Pi locally, put pi on PATH, or set PI_BIN/PI_CODING_AGENT_PACKAGE_DIR for tests.`,
);

const piAi = await importWithFallback(
	PI_AI_PACKAGE_NAME,
	PI_PACKAGE_DIR ? join(PI_PACKAGE_DIR, "node_modules", PI_AI_PACKAGE_NAME, "dist", "index.js") : undefined,
	`Cannot import ${PI_AI_PACKAGE_NAME}. Install Pi locally, put pi on PATH, or set PI_BIN/PI_CODING_AGENT_PACKAGE_DIR for tests.`,
);

const {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} = piSdk;

export {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
};

export function assistantText(text, options = {}) {
	return piAi.fauxAssistantMessage(text, options);
}

export function assistantToolCall(name, args, id) {
	return piAi.fauxAssistantMessage(
		piAi.fauxToolCall(name, args, id === undefined ? undefined : { id }),
		{ stopReason: "toolUse" },
	);
}

function saveEnv(keys) {
	return new Map(Array.from(keys, (key) => [key, process.env[key]]));
}

function restoreEnv(savedEnv) {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function emitTestSessionShutdown(session) {
	// Pi's real runtime emits session_shutdown before disposal. The SDK test
	// harness owns sessions directly, so mirror that lifecycle enough for
	// extensions that keep process-global ownership counts.
	void session?.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
}

function applySessionEnv(agentDir, extraEnv = {}) {
	const managedKeys = new Set([
		"PATH",
		"PI_CODING_AGENT_DIR",
		"PI_OFFLINE",
		"SANDBURG_ACTIVE",
		"SANDBURG_AGENT_DIR",
		"SANDBURG_TOOL_SANDBOX",
		"SANDBURG_PRIVATE_PATHS",
		"SANDBURG_PASS_VARS",
		...Object.keys(extraEnv),
	]);
	const savedEnv = saveEnv(managedKeys);

	for (const key of managedKeys) delete process.env[key];
	pointSdkImportBinDirAt(agentDir);
	process.env.PATH = HOST_PATH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	Object.assign(process.env, extraEnv);

	return () => restoreEnv(savedEnv);
}

export async function runSandburgToolCall({ cwd, agentDir, toolName, args, env = {}, tools, prompt, extraExtensionPaths }) {
	let harness;
	try {
		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env,
			tools,
			extraExtensionPaths,
			responses: [assistantToolCall(toolName, args), assistantText("done")],
		});
		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt(prompt ?? `run ${toolName}`);
		const toolEnd = findToolEnd(events, toolName);
		assert.ok(toolEnd, `expected a ${toolName} tool_execution_end event`);
		assert.equal(lastAssistantText(events), "done");
		return { events, toolEnd, resultText: toolResultText(toolEnd) };
	} finally {
		harness?.dispose();
	}
}

export async function createSandburgSdkSession({ cwd, agentDir, responses, env = {}, tools, extraExtensionPaths = [] }) {
	if (!cwd) throw new Error("createSandburgSdkSession requires cwd");
	if (!agentDir) throw new Error("createSandburgSdkSession requires agentDir");
	if (!Array.isArray(responses)) throw new Error("createSandburgSdkSession requires a responses array");

	const restoreProcessEnv = applySessionEnv(agentDir, env);
	const faux = piAi.registerFauxProvider({
		provider: `sandburg-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	});
	faux.setResponses(responses);

	let session;
	let unsubscribe = () => {};
	try {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(faux.getModel().provider, "dummy");

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
		});

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [sandburgExtensionPath(), ...extraExtensionPaths],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			model: faux.getModel(),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			...(tools ? { tools } : {}),
		});
		session = result.session;
		await session.bindExtensions({});

		const events = [];
		let disposed = false;
		unsubscribe = session.subscribe((event) => events.push(event));

		return {
			session,
			events,
			faux,
			extensionsResult: result.extensionsResult,
			async prompt(text = "go") {
				await session.prompt(text);
				return events;
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				unsubscribe();
				emitTestSessionShutdown(session);
				session.dispose();
				faux.unregister();
				restoreProcessEnv();
			},
		};
	} catch (error) {
		unsubscribe();
		emitTestSessionShutdown(session);
		session?.dispose();
		faux.unregister();
		restoreProcessEnv();
		throw error;
	}
}
