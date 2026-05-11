// Invalid helper setup tests

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

test("Sandburg disables tools when a helper path is unmanaged", async () => {
	const dir = await mkTestDir("sandburg-setup-invalid");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		const unmanagedHelperPath = join(agentBinDir, "sandburg-tool-sandbox");
		const unmanagedHelper = "#!/bin/sh\necho unmanaged helper should not be overwritten\n";
		await mkdir(cwd, { recursive: true });
		await mkdir(agentBinDir, { recursive: true });
		await writeFile(unmanagedHelperPath, unmanagedHelper, { mode: 0o755 });

		const { toolEnd, resultText } = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "bash",
			args: { command: "printf should-not-run", timeout: 2 },
			prompt: "try a tool after invalid setup",
		});

		assert.equal(toolEnd.isError, true);
		assert.match(resultText, /Tool bash not found|disabled all tools/);
		assert.equal(await readFile(unmanagedHelperPath, "utf8"), unmanagedHelper);
	} finally {
		await rmTestDir(dir);
	}
});
