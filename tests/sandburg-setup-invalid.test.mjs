import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { findToolEnd, lastAssistantText, toolResultText } from "./helpers/events.mjs";
import { mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { assistantText, assistantToolCall, createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

test("Sandburg disables tools when a helper path is unmanaged", async () => {
	const dir = await mkTestDir("sandburg-setup-invalid");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const unmanagedHelperPath = join(agentBinDir, "sandburg-tool-sandbox");
		const unmanagedHelper = "#!/bin/sh\necho unmanaged helper should not be overwritten\n";
		await mkdir(cwd, { recursive: true });
		await mkdir(agentBinDir, { recursive: true });
		await writeFile(unmanagedHelperPath, unmanagedHelper, { mode: 0o755 });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [
				assistantToolCall("bash", { command: "printf should-not-run", timeout: 2 }),
				assistantText("done"),
			],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt("try a tool after invalid setup");
		const bashEnd = findToolEnd(events, "bash");
		assert.ok(bashEnd, "expected a bash tool_execution_end event");
		assert.equal(bashEnd.isError, true);
		assert.match(toolResultText(bashEnd), /Tool bash not found|disabled all tools/);
		assert.equal(lastAssistantText(events), "done");
		assert.equal(await readFile(unmanagedHelperPath, "utf8"), unmanagedHelper);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});
