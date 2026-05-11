import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { findToolEnd, parseJsonLines, toolResultText } from "./helpers/events.mjs";
import {
	bwrapUsable,
	mkTestDir,
	piBinPath,
	piSubprocessEnv,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

test("Pi CLI JSON mode loads Sandburg and runs a scripted bash tool call", async (t) => {
	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const dir = await mkTestDir("pi-cli-json");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		const script = [
			{
				toolCalls: [
					{
						name: "bash",
						arguments: {
							command: "printf 'cli:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
							timeout: 2,
						},
					},
				],
			},
			{ text: "done" },
		];

		const result = spawnSync(
			piBin,
			[
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"-e",
				join(repoRoot(), "tests", "fixtures", "scripted-provider.ts"),
				"-e",
				sandburgExtensionPath(),
				"--provider",
				"sandburg-test",
				"--model",
				"scripted",
				"run scripted CLI test",
			],
			{
				cwd,
				env: piSubprocessEnv({
					piBin,
					agentDir,
					home: cwd,
					extra: {
						SANDBURG_TEST_PROVIDER_API_KEY: "dummy",
						SANDBURG_TEST_PROVIDER_SCRIPT: JSON.stringify(script),
					},
				}),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30000,
			},
		);

		assert.equal(
			result.status,
			0,
			`pi exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
		assert.doesNotMatch(result.stderr, /extension load|failed to load|cannot load/i);

		const events = parseJsonLines(result.stdout);
		const bashEnd = findToolEnd(events, "bash");
		assert.ok(bashEnd, "expected a bash tool_execution_end event");
		assert.equal(bashEnd.isError, false);
		assert.match(toolResultText(bashEnd), /cli:1/);
	} finally {
		await rmTestDir(dir);
	}
});
