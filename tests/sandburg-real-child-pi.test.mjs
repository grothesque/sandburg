// Real Pi CLI child-process propagation smoke test

import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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

test("real Pi CLI child spawn reaches Sandburg's managed wrapper", async (t) => {
	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const dir = await mkTestDir("sandburg-pi-wrapper-real-child");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const childRecordPath = join(dir, "child-record.json");
		const scriptedProviderPath = join(repoRoot(), "tests", "fixtures", "scripted-provider.ts");
		const childScript = [
			{
				toolCalls: [
					{
						name: "bash",
						arguments: {
							command: "printf 'child:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
							timeout: 2,
						},
					},
				],
			},
			{ text: "child done" },
		];
		const childArgs = [
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"-e",
			scriptedProviderPath,
			"--provider",
			"sandburg-test",
			"--model",
			"scripted",
			"run child Sandburg propagation probe",
		];
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		const input = `${JSON.stringify({ id: "spawn", type: "prompt", message: "/spawn-pi-probe" })}\n`;
		const result = spawnSync(
			piBin,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"-e",
				scriptedProviderPath,
				"-e",
				sandburgExtensionPath(),
				"-e",
				join(repoRoot(), "tests", "fixtures", "spawn-pi-extension.ts"),
				"--provider",
				"sandburg-test",
				"--model",
				"scripted",
			],
			{
				cwd,
				env: piSubprocessEnv({
					piBin,
					agentDir,
					home: cwd,
					extra: {
						SANDBURG_TEST_PROVIDER_API_KEY: "dummy",
						SANDBURG_TEST_PROVIDER_SCRIPT: JSON.stringify(childScript),
						SANDBURG_TEST_SPAWN_PI_ARGS_JSON: JSON.stringify(childArgs),
						SANDBURG_TEST_SPAWN_PI_RECORD: childRecordPath,
						SANDBURG_TEST_SPAWN_PI_TIMEOUT_MS: "30000",
					},
				}),
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 60000,
			},
		);

		assert.equal(
			result.status,
			0,
			`parent pi exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
		assert.doesNotMatch(result.stderr, /extension load|failed to load|cannot load/i);
		const parentMessages = parseJsonLines(result.stdout);
		const parentResponse = parentMessages.find((message) => message.type === "response" && message.id === "spawn");
		assert.equal(parentResponse?.success, true, `expected /spawn-pi-probe to succeed; stdout:\n${result.stdout}`);

		const childRecord = JSON.parse(await readFile(childRecordPath, "utf8"));
		assert.equal(
			childRecord.status,
			0,
			`child pi exited with status ${childRecord.status}\nstdout:\n${childRecord.stdout}\nstderr:\n${childRecord.stderr}`,
		);
		assert.doesNotMatch(childRecord.stderr, /extension load|failed to load|cannot load/i);

		const childEvents = parseJsonLines(childRecord.stdout);
		const bashEnd = findToolEnd(childEvents, "bash");
		assert.ok(bashEnd, `expected child pi to run a bash tool call; stdout:\n${childRecord.stdout}`);
		assert.equal(bashEnd.isError, false, toolResultText(bashEnd));
		assert.match(toolResultText(bashEnd), /child:1/);
	} finally {
		await rmTestDir(dir);
	}
});
