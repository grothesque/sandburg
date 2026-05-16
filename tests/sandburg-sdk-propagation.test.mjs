// SDK-created nested session propagation tests

import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createSandburgSdkSession,
} from "./helpers/pi-sdk-harness.mjs";
import {
	mkTestDir,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });

function sandburgIndexPath() {
	return realpathSync(join(sandburgExtensionPath(), "index.ts"));
}

function loaderAdditionalExtensionPaths(loader) {
	return loader.additionalExtensionPaths;
}

function createNestedLoader({ cwd, agentDir, additionalExtensionPaths = [], settingsManager }) {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

function isSandburgToolSource(tool) {
	return tool?.sourceInfo.path.replace(/\\/g, "/").endsWith("/sandburg/index.ts");
}

async function getRuntimeState() {
	const runtime = await jiti.import("../extensions/sandburg/runtime-state.ts");
	return runtime.getSandburgRuntimeState();
}

function envOwnerCount(state, name) {
	return state.envVars.get(name)?.owners.size ?? 0;
}

async function disposeNestedSession(session) {
	await session?.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
	session?.dispose();
}

async function createNestedSession({ cwd, agentDir, loader, model, settingsManager }) {
	const authStorage = AuthStorage.create(join(agentDir, "nested-auth.json"));
	authStorage.setRuntimeApiKey(model.provider, "dummy");
	const result = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry: ModelRegistry.inMemory(authStorage),
		model,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
	});
	await result.session.bindExtensions({});
	return result;
}

test("SANDBURG_DISABLE_PROPAGATION=sdk prevents SDK loader interposition", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-disabled");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env: { SANDBURG_DISABLE_PROPAGATION: "sdk" },
			responses: [],
		});
		assert.deepEqual(harness.extensionsResult.errors, []);

		const nestedLoader = createNestedLoader({ cwd, agentDir });
		await nestedLoader.reload();

		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), []);
		assert.deepEqual(nestedLoader.getExtensions().extensions, []);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg adds itself to SDK-created DefaultResourceLoader reloads", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-active");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const sandburgPath = sandburgIndexPath();
		const otherExtensionPath = join(repoRoot(), "tests", "fixtures", "bash-override-extension.ts");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });
		assert.deepEqual(harness.extensionsResult.errors, []);

		const nestedLoader = createNestedLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [otherExtensionPath],
		});
		await nestedLoader.reload();

		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), [sandburgPath, otherExtensionPath]);
		assert.ok(
			nestedLoader.getExtensions().extensions.some((extension) => extension.resolvedPath === sandburgPath),
			"expected nested loader to load Sandburg as an explicit extension",
		);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("SDK discovery-only propagation does not add process env ownership", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-discovery-only");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const sandburgPath = sandburgIndexPath();
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });
		assert.deepEqual(harness.extensionsResult.errors, []);

		const state = await getRuntimeState();
		assert.equal(envOwnerCount(state, "SANDBURG_ACTIVE"), 1);
		assert.equal(envOwnerCount(state, "SANDBURG_AGENT_DIR"), 1);

		const nestedLoader = createNestedLoader({ cwd, agentDir });
		await nestedLoader.reload();

		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), [sandburgPath]);
		assert.ok(
			nestedLoader.getExtensions().extensions.some((extension) => extension.resolvedPath === sandburgPath),
			"expected discovery-only nested loader to load Sandburg",
		);
		assert.equal(envOwnerCount(state, "SANDBURG_ACTIVE"), 1);
		assert.equal(envOwnerCount(state, "SANDBURG_AGENT_DIR"), 1);

		harness.dispose();
		harness = undefined;
		assert.equal(envOwnerCount(state, "SANDBURG_ACTIVE"), 0);
		assert.equal(envOwnerCount(state, "SANDBURG_AGENT_DIR"), 0);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg SDK propagation deduplicates its own extension path and keeps it first", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-dedupe");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const sandburgPath = sandburgIndexPath();
		const otherExtensionPath = join(repoRoot(), "tests", "fixtures", "bash-override-extension.ts");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });
		assert.deepEqual(harness.extensionsResult.errors, []);

		const nestedLoader = createNestedLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [repoRoot(), otherExtensionPath, sandburgExtensionPath(), sandburgPath],
		});
		await nestedLoader.reload();

		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), [sandburgPath, otherExtensionPath]);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg SDK propagation stops injecting after Sandburg is inactive", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-inactive");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });
		assert.deepEqual(harness.extensionsResult.errors, []);
		harness.dispose();
		harness = undefined;

		const nestedLoader = createNestedLoader({ cwd, agentDir });
		await nestedLoader.reload();

		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), []);
		assert.deepEqual(nestedLoader.getExtensions().extensions, []);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("SDK-created nested sessions receive Sandburg-managed built-in tools", async () => {
	const dir = await mkTestDir("sandburg-sdk-propagation-nested-session");
	let harness;
	let nestedSession;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const sandburgPath = sandburgIndexPath();
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });
		assert.deepEqual(harness.extensionsResult.errors, []);

		const nestedSettingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		const nestedLoader = createNestedLoader({ cwd, agentDir, settingsManager: nestedSettingsManager });
		await nestedLoader.reload();
		assert.deepEqual(loaderAdditionalExtensionPaths(nestedLoader), [sandburgPath]);

		const nestedResult = await createNestedSession({
			cwd,
			agentDir,
			loader: nestedLoader,
			model: harness.faux.getModel(),
			settingsManager: nestedSettingsManager,
		});
		nestedSession = nestedResult.session;
		assert.deepEqual(nestedResult.extensionsResult.errors, []);

		const tools = new Map(nestedSession.getAllTools().map((tool) => [tool.name, tool]));
		for (const toolName of ["read", "bash", "write", "edit"]) {
			assert.ok(isSandburgToolSource(tools.get(toolName)), `expected ${toolName} to be Sandburg-managed`);
		}
		for (const toolName of ["grep", "find", "ls"]) {
			assert.equal(tools.get(toolName)?.sourceInfo.source, "builtin", `expected ${toolName} to remain built-in`);
		}
	} finally {
		await disposeNestedSession(nestedSession);
		harness?.dispose();
		await rmTestDir(dir);
	}
});
