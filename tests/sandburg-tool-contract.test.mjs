import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

const SANDBURG_REQUIRED_DEFAULT_TOOLS = ["bash", "read", "write", "edit"];
const SANDBURG_KNOWN_TOOL_NAMES = new Set([...SANDBURG_REQUIRED_DEFAULT_TOOLS, "grep", "find", "ls"]);

test("Sandburg normal sessions have no unexpected active tools", async () => {
	const dir = await mkTestDir("sandburg-tool-contract");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const activeToolNames = harness.session.getActiveToolNames().sort();
		for (const toolName of SANDBURG_REQUIRED_DEFAULT_TOOLS) {
			assert.ok(activeToolNames.includes(toolName), `expected ${toolName} to be active`);
		}

		const unexpectedActiveTools = activeToolNames.filter((name) => !SANDBURG_KNOWN_TOOL_NAMES.has(name));
		assert.deepEqual(unexpectedActiveTools, []);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});
