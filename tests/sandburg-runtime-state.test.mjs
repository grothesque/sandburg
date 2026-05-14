// Process-global runtime state tests

import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function importRuntimeState() {
	const mod = await jiti.import("../extensions/sandburg/runtime-state.ts");
	mod.__resetSandburgRuntimeStateForTests();
	return mod;
}

function sortedSet(value) {
	return Array.from(value).sort();
}

function saveEnv(keys) {
	return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(savedEnv) {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test("Sandburg parses propagation disable tokens", async () => {
	const runtime = await importRuntimeState();

	const parsed = runtime.parsePropagationDisableTokens(" pi-wrapper, sdk, unknown-token, argv1 ");
	assert.deepEqual(sortedSet(parsed.tokens), ["argv1", "pi-wrapper", "sdk"]);
	assert.deepEqual(sortedSet(parsed.disabled), ["argv1", "pi-wrapper", "sdk"]);
	assert.deepEqual(parsed.unknownTokens, ["unknown-token"]);

	const all = runtime.parsePropagationDisableTokens("all");
	assert.deepEqual(sortedSet(all.tokens), ["all"]);
	assert.deepEqual(sortedSet(all.disabled), ["argv1", "pi-wrapper", "sdk"]);
	assert.deepEqual(all.unknownTokens, []);
});

test("Sandburg-owned process env survives overlapping owners", async () => {
	const keys = ["SANDBURG_ACTIVE", "SANDBURG_AGENT_DIR", "SANDBURG_AUTH_PATH"];
	const savedEnv = saveEnv(keys);
	const runtime = await importRuntimeState();

	try {
		for (const key of keys) delete process.env[key];

		const first = runtime.claimSandburgProcessEnv({
			SANDBURG_ACTIVE: "sandburg-extension-v1",
			SANDBURG_AGENT_DIR: "/tmp/sandburg-agent-a",
			SANDBURG_AUTH_PATH: "/tmp/sandburg-agent-a/auth.json",
		});
		const second = runtime.claimSandburgProcessEnv({
			SANDBURG_ACTIVE: "sandburg-extension-v1",
			SANDBURG_AGENT_DIR: "/tmp/sandburg-agent-b",
			SANDBURG_AUTH_PATH: "/tmp/sandburg-agent-b/auth.json",
		});

		assert.equal(process.env.SANDBURG_ACTIVE, "sandburg-extension-v1");
		assert.equal(process.env.SANDBURG_AGENT_DIR, "/tmp/sandburg-agent-b");
		assert.equal(process.env.SANDBURG_AUTH_PATH, "/tmp/sandburg-agent-b/auth.json");

		second.release();
		assert.equal(process.env.SANDBURG_ACTIVE, "sandburg-extension-v1");
		assert.equal(process.env.SANDBURG_AGENT_DIR, "/tmp/sandburg-agent-a");
		assert.equal(process.env.SANDBURG_AUTH_PATH, "/tmp/sandburg-agent-a/auth.json");

		first.release();
		assert.equal(process.env.SANDBURG_ACTIVE, undefined);
		assert.equal(process.env.SANDBURG_AGENT_DIR, undefined);
		assert.equal(process.env.SANDBURG_AUTH_PATH, undefined);

		// Release handles are idempotent.
		first.release();
		second.release();
		assert.equal(process.env.SANDBURG_ACTIVE, undefined);
	} finally {
		runtime.__resetSandburgRuntimeStateForTests();
		restoreEnv(savedEnv);
	}
});
