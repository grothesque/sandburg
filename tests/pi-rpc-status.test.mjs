// Real Pi RPC /sandburg status smoke test

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

function assertPiRpcSucceeded(result) {
	assert.equal(
		result.status,
		0,
		`pi exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	assert.doesNotMatch(result.stderr, /extension load|failed to load|cannot load/i);
}

function rpcResponse(messages, id) {
	const response = messages.find((message) => message.type === "response" && message.id === id);
	assert.ok(response, `expected ${id} response`);
	return response;
}

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

		assertPiRpcSucceeded(result);

		const messages = parseJsonLines(result.stdout);
		const commandsResponse = rpcResponse(messages, "commands");
		assert.equal(commandsResponse.success, true);
		assert.ok(
			commandsResponse.data.commands.some(
				(command) => command.name === "sandburg" && command.source === "extension",
			),
			"expected Sandburg slash command to be registered",
		);

		const promptResponse = rpcResponse(messages, "sandburg-status");
		assert.equal(promptResponse.success, true);

		const statusNotify = messages.find(
			(message) => message.type === "extension_ui_request" && message.method === "notify"
				&& message.message.includes("Agent tool restrictions"),
		);
		assert.ok(statusNotify, "expected /sandburg to emit a status notification");
		assert.match(statusNotify.message, /Agent tool restrictions/);
		assert.match(statusNotify.message, /network disabled/);
		assert.match(statusNotify.message, /Nested Pi propagation/);
		assert.match(statusNotify.message, /argv\[1\] propagation: not enabled/);
		assert.doesNotMatch(statusNotify.message, /Additional tools are active/);
	} finally {
		await rmTestDir(dir);
	}
});

test("Pi RPC mode loads Sandburg from the local package root", async (t) => {
	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}

	const dir = await mkTestDir("pi-rpc-package-root");
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
				repoRoot(),
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

		assertPiRpcSucceeded(result);

		const messages = parseJsonLines(result.stdout);
		const commandsResponse = rpcResponse(messages, "commands");
		assert.equal(commandsResponse.success, true);
		assert.ok(
			commandsResponse.data.commands.some(
				(command) => command.name === "sandburg" && command.source === "extension",
			),
			"expected Sandburg slash command to be registered when loaded from package root",
		);
		assert.equal(rpcResponse(messages, "sandburg-status").success, true);
	} finally {
		await rmTestDir(dir);
	}
});

test("Pi RPC Sandburg status reports runtime-added active tools", async (t) => {
	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}

	const dir = await mkTestDir("pi-rpc-status-runtime-tool");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const runtimeToolName = "runtime_extra_probe";
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		const input = [
			{ id: "sandburg-status-before", type: "prompt", message: "/sandburg" },
			{ id: "add-runtime-tool", type: "prompt", message: `/tooltester-add ${runtimeToolName}` },
			{ id: "sandburg-status-after", type: "prompt", message: "/sandburg" },
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
				"-e",
				join(repoRoot(), "dev-extensions", "tooltester.ts"),
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

		assertPiRpcSucceeded(result);

		const messages = parseJsonLines(result.stdout);
		assert.equal(rpcResponse(messages, "sandburg-status-before").success, true);
		assert.equal(rpcResponse(messages, "add-runtime-tool").success, true);
		assert.equal(rpcResponse(messages, "sandburg-status-after").success, true);

		const statusNotifications = messages.filter(
			(message) => message.type === "extension_ui_request" && message.method === "notify"
				&& message.message.includes("Agent tool restrictions"),
		);
		assert.equal(statusNotifications.length, 2);
		assert.doesNotMatch(statusNotifications[0].message, new RegExp(runtimeToolName));
		assert.match(statusNotifications[1].message, new RegExp(runtimeToolName));
		assert.match(statusNotifications[1].message, /Additional tools are active outside Sandburg's built-in-tool sandbox/);
		assert.match(statusNotifications[1].message, /Extension tools are assumed trusted and remain enabled/);
	} finally {
		await rmTestDir(dir);
	}
});
