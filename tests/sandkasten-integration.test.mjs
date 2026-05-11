import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonLines } from "./helpers/events.mjs";
import {
	DEFAULT_PATH,
	mkTestDir,
	piBinPath,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

function sandkastenCommand() {
	return process.env.SKN_BIN ?? "skn";
}

function sandkastenHostEnv() {
	return {
		PATH: process.env.PATH ?? DEFAULT_PATH,
		SKN_PATH_CHECK: "true",
	};
}

function usableSandkasten(skn) {
	const result = spawnSync(skn, ["true"], {
		env: sandkastenHostEnv(),
		stdio: "ignore",
		timeout: 10000,
	});
	return result.status === 0;
}

function piPackageDirForCli(piCli) {
	const candidate = dirname(dirname(piCli));
	return existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "dist", "index.js"))
		? candidate
		: undefined;
}

test("Pi RPC status works inside optional Sandkasten outer sandbox", async (t) => {
	const skn = sandkastenCommand();
	if (!usableSandkasten(skn)) {
		t.skip("skn is unavailable or unusable in this environment; set SKN_BIN or put skn on PATH");
		return;
	}

	const piBin = piBinPath();
	if (!piBin) {
		t.skip("Pi CLI not found; set PI_BIN or put pi on PATH");
		return;
	}

	const dir = await mkTestDir("sandkasten-integration");
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		const piCli = realpathSync(piBin);
		const piPackageDir = piPackageDirForCli(piCli);
		const piReadBind = piPackageDir ?? piCli;
		const input = [
			{ id: "sandburg-status", type: "prompt", message: "/sandburg" },
		]
			.map((command) => JSON.stringify(command))
			.join("\n") + "\n";

		const result = spawnSync(
			skn,
			[
				piCli,
				"+R",
				piReadBind,
				"+R",
				repoRoot(),
				"+W",
				cwd,
				"+W",
				agentDir,
				"+V",
				`PI_CODING_AGENT_DIR=${agentDir}`,
				"+V",
				"PI_OFFLINE=1",
				"+V",
				`PATH=${DEFAULT_PATH}`,
				"+V",
				`HOME=${cwd}`,
				"+V",
				"SANDBURG_TEST_PROVIDER_API_KEY=dummy",
				"+V",
				"SANDBURG_TEST_PROVIDER_SCRIPT=[]",
				"--",
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
				env: sandkastenHostEnv(),
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 30000,
			},
		);

		assert.equal(
			result.status,
			0,
			`skn/pi exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
		assert.doesNotMatch(result.stderr, /extension load|failed to load|cannot load/i);

		const messages = parseJsonLines(result.stdout);
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
		assert.match(statusNotify.message, /Outer sandbox for the pi process/);
		assert.match(statusNotify.message, /Agent tool restrictions/);
		assert.match(statusNotify.message, /network disabled/);
		assert.doesNotMatch(statusNotify.message, /No outer sandbox for the pi process detected/);
		assert.doesNotMatch(statusNotify.message, /Broad host exposure detected/);
	} finally {
		await rmTestDir(dir);
	}
});
