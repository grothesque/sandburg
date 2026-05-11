import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bwrapUsable, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

async function runGrepToolCall({ cwd, agentDir, args }) {
	return runSandburgToolCall({
		cwd,
		agentDir,
		toolName: "grep",
		args,
		tools: ["grep"],
		prompt: "run grep",
	});
}

test("Sandburg grep searches project files when enabled", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const dir = await mkTestDir("sandburg-grep-project");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "notes.txt"), "alpha\nneedle here\nomega\n", "utf8");

		const { toolEnd, resultText } = await runGrepToolCall({
			cwd,
			agentDir,
			args: { pattern: "needle", path: ".", literal: true, limit: 5 },
		});

		assert.equal(toolEnd.isError, false);
		assert.match(resultText, /notes\.txt:2: needle here/);
	} finally {
		await rmTestDir(dir);
	}
});

test("Sandburg grep cannot see masked Pi credentials", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const dir = await mkTestDir("sandburg-grep-auth");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const authPath = join(agentDir, "auth.json");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(authPath, "secret-token-visible-without-sandbox\n", "utf8");

		const { toolEnd, resultText } = await runGrepToolCall({
			cwd,
			agentDir,
			args: {
				pattern: "secret-token-visible-without-sandbox",
				path: authPath,
				literal: true,
				limit: 5,
			},
		});

		assert.equal(toolEnd.isError, false);
		assert.doesNotMatch(resultText, /secret-token-visible-without-sandbox/);
		assert.match(resultText, /No matches found/);
	} finally {
		await rmTestDir(dir);
	}
});
