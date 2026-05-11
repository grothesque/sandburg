import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonLines } from "./helpers/events.mjs";
import {
	mkTestDir,
	piBinPath,
	piSubprocessEnv,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

test("Pi RPC mode exposes and runs the Sandburg status command", async (t) => {
	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}

	const dir = await mkTestDir("pi-rpc-status");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		const input = [
			{ id: "commands", type: "get_commands" },
			{ id: "sandburg-status", type: "prompt", message: "/sandburg" },
		]
			.map((command) => JSON.stringify(command))
			.join("\n") + "\n";

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
				join(repoRoot(), "tests", "fixtures", "scripted-provider.ts"),
				"-e",
				sandburgExtensionPath(),
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
						SANDBURG_TEST_PROVIDER_SCRIPT: "[]",
					},
				}),
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 30000,
			},
		);

		assert.equal(
			result.status,
			0,
			`pi exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
		assert.doesNotMatch(result.stderr, /extension load|failed to load|cannot load/i);

		const messages = parseJsonLines(result.stdout);
		const commandsResponse = messages.find(
			(message) => message.type === "response" && message.id === "commands",
		);
		assert.ok(commandsResponse, "expected get_commands response");
		assert.equal(commandsResponse.success, true);
		assert.ok(
			commandsResponse.data.commands.some(
				(command) => command.name === "sandburg" && command.source === "extension",
			),
			"expected Sandburg slash command to be registered",
		);

		const promptResponse = messages.find(
			(message) => message.type === "response" && message.id === "sandburg-status",
		);
		assert.ok(promptResponse, "expected /sandburg prompt response");
		assert.equal(promptResponse.success, true);

		const statusNotify = messages.find(
			(message) => message.type === "extension_ui_request" && message.method === "notify"
				&& message.message.includes("Agent tool restrictions"),
		);
		assert.ok(statusNotify, "expected /sandburg to emit a status notification");
		assert.match(statusNotify.message, /Agent tool restrictions/);
		assert.match(statusNotify.message, /network disabled/);
	} finally {
		await rmTestDir(dir);
	}
});
