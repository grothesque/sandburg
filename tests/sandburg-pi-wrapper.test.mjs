// Managed nested-Pi wrapper tests

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PATH, mkTestDir, repoRoot, rmTestDir, sandburgExtensionPath } from "./helpers/test-env.mjs";
import { createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const PI_WRAPPER_MARKER = "// sandburg-extension-managed: pi-wrapper";
const ACTIVE_MARKER = "sandburg-extension-v1";

function saveEnv(keys) {
	return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(savedEnv) {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function importHelpersForAgentDir(agentDir) {
	const savedEnv = saveEnv(["PI_CODING_AGENT_DIR", "PATH"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = DEFAULT_PATH;
	try {
		return await jiti.import("../extensions/sandburg/helpers.ts");
	} finally {
		restoreEnv(savedEnv);
	}
}

async function installWrapper(agentDir) {
	const helpers = await importHelpersForAgentDir(agentDir);
	const result = helpers.installSandburgPiWrapper();
	assert.equal(result.status, "installed", result.violations.join("\n"));
	return result.path;
}

async function writeFakeRealPi(path) {
	await writeFile(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SANDBURG_FAKE_REAL_PI_RECORD, JSON.stringify({
	argv: process.argv.slice(2),
	propagated: process.env.SANDBURG_PROPAGATED_CHILD,
}));
process.exit(Number(process.env.SANDBURG_FAKE_REAL_PI_EXIT || "0"));
`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
}

async function readRecord(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function runActiveWrapper(wrapperPath, args, { fakeRealPi, recordPath, sandburgExtensionPath }) {
	return spawnSync(wrapperPath, args, {
		env: {
			PATH: DEFAULT_PATH,
			SANDBURG_ACTIVE: ACTIVE_MARKER,
			SANDBURG_REAL_PI_COMMAND: process.execPath,
			SANDBURG_REAL_PI_ARGS_JSON: JSON.stringify([fakeRealPi]),
			SANDBURG_EXTENSION_PATH: sandburgExtensionPath,
			SANDBURG_FAKE_REAL_PI_RECORD: recordPath,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5000,
	});
}

test("Sandburg installs a stable executable JavaScript pi wrapper", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-install");
	try {
		const agentDir = join(dir, "agent");
		await mkdir(agentDir, { recursive: true });

		const wrapperPath = await installWrapper(agentDir);
		const wrapper = await readFile(wrapperPath, "utf8");

		assert.match(wrapper, /^#!\/usr\/bin\/env node/);
		assert.match(wrapper, new RegExp(PI_WRAPPER_MARKER));
		assert.doesNotMatch(wrapper, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		await import("node:fs/promises").then(({ access }) => access(wrapperPath, constants.X_OK));
	} finally {
		await rmTestDir(dir);
	}
});

test("Sandburg pi wrapper injects Sandburg into normal child Pi invocations", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-inject");
	try {
		const agentDir = join(dir, "agent");
		await mkdir(agentDir, { recursive: true });
		const wrapperPath = await installWrapper(agentDir);
		const fakeRealPi = join(dir, "real-pi");
		const recordPath = join(dir, "record.json");
		const sandburgExtensionPath = join(dir, "sandburg", "index.ts");
		await writeFakeRealPi(fakeRealPi);

		const result = runActiveWrapper(wrapperPath, ["--no-extensions", "--mode", "json", "hello"], {
			fakeRealPi,
			recordPath,
			sandburgExtensionPath,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual((await readRecord(recordPath)).argv, [
			"-e",
			sandburgExtensionPath,
			"--no-extensions",
			"--mode",
			"json",
			"hello",
		]);
		assert.equal((await readRecord(recordPath)).propagated, "1");
	} finally {
		await rmTestDir(dir);
	}
});

test("Sandburg pi wrapper delegates package commands unchanged", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-package-command");
	try {
		const agentDir = join(dir, "agent");
		await mkdir(agentDir, { recursive: true });
		const wrapperPath = await installWrapper(agentDir);
		const fakeRealPi = join(dir, "real-pi");
		const recordPath = join(dir, "record.json");
		await writeFakeRealPi(fakeRealPi);

		const result = runActiveWrapper(wrapperPath, ["install", "npm:@example/pkg"], {
			fakeRealPi,
			recordPath,
			sandburgExtensionPath: join(dir, "sandburg", "index.ts"),
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual((await readRecord(recordPath)).argv, ["install", "npm:@example/pkg"]);
	} finally {
		await rmTestDir(dir);
	}
});

test("stale Sandburg pi wrapper delegates transparently outside active Sandburg sessions", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-stale-transparent");
	try {
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const realBinDir = join(dir, "real-bin");
		const wrapperPath = await installWrapper(agentDir);
		const realPi = join(realBinDir, "pi");
		const recordPath = join(dir, "record.json");
		await mkdir(realBinDir, { recursive: true });
		await writeFakeRealPi(realPi);

		const result = spawnSync(wrapperPath, ["--mode", "json", "hello"], {
			env: {
				PATH: [agentBinDir, realBinDir, DEFAULT_PATH].join(delimiter),
				SANDBURG_FAKE_REAL_PI_RECORD: recordPath,
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});

		assert.equal(result.status, 0, result.stderr);
		const record = await readRecord(recordPath);
		assert.deepEqual(record.argv, ["--mode", "json", "hello"]);
		assert.equal(record.propagated, undefined);
	} finally {
		await rmTestDir(dir);
	}
});

test("active Sandburg pi wrapper still fails closed without propagation configuration", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-active-missing-config");
	try {
		const agentDir = join(dir, "agent");
		const wrapperPath = await installWrapper(agentDir);

		const result = spawnSync(wrapperPath, ["hello"], {
			env: {
				PATH: DEFAULT_PATH,
				SANDBURG_ACTIVE: ACTIVE_MARKER,
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});

		assert.equal(result.status, 127);
		assert.match(result.stderr, /SANDBURG_REAL_PI_COMMAND is not set/);
	} finally {
		await rmTestDir(dir);
	}
});

test("stale Sandburg pi wrapper does not recurse into managed wrappers", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-stale-no-recursion");
	try {
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const otherBinDir = join(dir, "other-bin");
		const wrapperPath = await installWrapper(agentDir);
		const otherWrapperPath = join(otherBinDir, "pi");
		await mkdir(otherBinDir, { recursive: true });
		await writeFile(otherWrapperPath, await readFile(wrapperPath, "utf8"), { mode: 0o755 });
		await chmod(otherWrapperPath, 0o755);

		const result = spawnSync(wrapperPath, ["hello"], {
			env: {
				PATH: [agentBinDir, dirname(process.execPath), otherBinDir].join(delimiter),
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});

		assert.equal(result.status, 127);
		assert.match(result.stderr, /not active and no real pi found on PATH/);
	} finally {
		await rmTestDir(dir);
	}
});

test("Sandburg does not enable pi wrapper propagation in non-Pi SDK hosts", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-sdk-host");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({ cwd, agentDir, responses: [] });

		assert.deepEqual(harness.extensionsResult.errors, []);
		assert.notEqual(process.env.PATH.split(delimiter)[0], agentBinDir);
		await assert.rejects(readFile(join(agentBinDir, "pi"), "utf8"), { code: "ENOENT" });

		const runtime = await jiti.import("../extensions/sandburg/runtime-state.ts");
		const state = runtime.getSandburgRuntimeState();
		assert.equal(state.piWrapperPropagation.status, "unavailable");
		assert.match(state.piWrapperPropagation.violations.join("\n"), /PI_CODING_AGENT=true is not set/);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg leaves an existing agent bin PATH entry in place in non-Pi SDK hosts", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-sdk-host-path");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const otherBinDir = join(dir, "other-bin");
		const originalPath = [otherBinDir, agentBinDir, DEFAULT_PATH].join(delimiter);
		await mkdir(cwd, { recursive: true });
		await mkdir(agentBinDir, { recursive: true });
		await mkdir(otherBinDir, { recursive: true });
		await writeFile(join(otherBinDir, "pi"), "#!/bin/sh\necho other pi\n", { mode: 0o755 });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env: { PATH: originalPath },
			responses: [],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);
		assert.equal(process.env.PATH, originalPath);
		await assert.rejects(readFile(join(agentBinDir, "pi"), "utf8"), { code: "ENOENT" });
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("SANDBURG_DISABLE_PROPAGATION=pi-wrapper prevents wrapper installation and PATH updates", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-disabled");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env: { SANDBURG_DISABLE_PROPAGATION: "pi-wrapper" },
			responses: [],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);
		assert.notEqual(process.env.PATH.split(delimiter)[0], agentBinDir);
		await assert.rejects(readFile(join(agentBinDir, "pi"), "utf8"), { code: "ENOENT" });
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg pi wrapper installer refuses an unmanaged wrapper path", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-unmanaged-path");
	try {
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const unmanagedPiPath = join(agentBinDir, "pi");
		const unmanagedPi = "#!/bin/sh\necho unmanaged pi wrapper\n";
		await mkdir(agentBinDir, { recursive: true });
		await writeFile(unmanagedPiPath, unmanagedPi, { mode: 0o755 });

		const helpers = await importHelpersForAgentDir(agentDir);
		const result = helpers.installSandburgPiWrapper();

		assert.equal(result.status, "unavailable");
		assert.match(result.violations.join("\n"), /unmanaged file/);
		assert.equal(await readFile(unmanagedPiPath, "utf8"), unmanagedPi);
	} finally {
		await rmTestDir(dir);
	}
});

test("extension subprocesses that spawn pi reach Sandburg's managed wrapper when propagation is configured", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-extension-spawn");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const fakeRealPi = join(dir, "real-pi");
		const recordPath = join(dir, "record.json");
		const nestedArgs = ["--no-extensions", "--mode", "json", "nested prompt"];
		const propagatedSandburgPath = realpathSync(join(sandburgExtensionPath(), "index.ts"));
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFakeRealPi(fakeRealPi);
		await installWrapper(agentDir);

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env: {
				PATH: [agentBinDir, DEFAULT_PATH].join(delimiter),
				SANDBURG_REAL_PI_COMMAND: process.execPath,
				SANDBURG_REAL_PI_ARGS_JSON: JSON.stringify([fakeRealPi]),
				SANDBURG_EXTENSION_PATH: propagatedSandburgPath,
				SANDBURG_TEST_SPAWN_PI_ARGS_JSON: JSON.stringify(nestedArgs),
				SANDBURG_FAKE_REAL_PI_RECORD: recordPath,
			},
			extraExtensionPaths: [join(repoRoot(), "tests", "fixtures", "spawn-pi-extension.ts")],
			responses: [],
		});
		assert.deepEqual(harness.extensionsResult.errors, []);

		await harness.session.prompt("/spawn-pi-probe");

		const record = await readRecord(recordPath);
		assert.deepEqual(record.argv, ["-e", propagatedSandburgPath, ...nestedArgs]);
		assert.equal(record.propagated, "1");
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});

test("Sandburg pi wrapper deduplicates its own explicit extension path", async () => {
	const dir = await mkTestDir("sandburg-pi-wrapper-dedupe");
	try {
		const agentDir = join(dir, "agent");
		await mkdir(agentDir, { recursive: true });
		const wrapperPath = await installWrapper(agentDir);
		const fakeRealPi = join(dir, "real-pi");
		const recordPath = join(dir, "record.json");
		const sandburgExtensionPath = join(dir, "sandburg", "index.ts");
		const otherExtensionPath = join(dir, "other", "index.ts");
		await writeFakeRealPi(fakeRealPi);

		const result = runActiveWrapper(
			wrapperPath,
			[
				"-e",
				sandburgExtensionPath,
				"--extension",
				sandburgExtensionPath,
				"-e",
				otherExtensionPath,
				`--extension=${sandburgExtensionPath}`,
				"prompt",
			],
			{ fakeRealPi, recordPath, sandburgExtensionPath },
		);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual((await readRecord(recordPath)).argv, [
			"-e",
			sandburgExtensionPath,
			"-e",
			otherExtensionPath,
			`--extension=${sandburgExtensionPath}`,
			"prompt",
		]);
	} finally {
		await rmTestDir(dir);
	}
});
