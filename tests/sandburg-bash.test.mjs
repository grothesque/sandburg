// Bash sandbox marker and credential masking tests

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventsOfType } from "./helpers/events.mjs";
import { bwrapUsable, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

async function runBashToolCall({ dirName, command, setup, env }) {
	const dir = await mkTestDir(dirName);
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await setup?.({ cwd, agentDir });
		const resolvedCommand = typeof command === "function" ? command({ cwd, agentDir }) : command;
		const resolvedEnv = typeof env === "function" ? env({ cwd, agentDir }) : env;

		const result = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "bash",
			args: { command: resolvedCommand, timeout: 2 },
			prompt: "run bash",
			env: resolvedEnv,
		});
		const bashStarts = eventsOfType(result.events, "tool_execution_start").filter((event) => event.toolName === "bash");

		assert.equal(bashStarts.length, 1);
		return result;
	} finally {
		await rmTestDir(dir);
	}
}

test("Sandburg bash tool runs inside the tool sandbox", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash",
		command: "printf 'sandbox:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
	});

	assert.equal(bashResult.toolEnd.isError, false);
	assert.match(bashResult.resultText, /sandbox:1/);
});

test("Sandburg bash cannot read private Pi agent state", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const secret = "secret-token-visible-without-sandbox";
	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash-agent-state",
		command: ({ agentDir }) => `printf 'auth:'; cat '${join(agentDir, "auth.json")}' 2>/dev/null || true; printf ':sessions:'; cat '${join(agentDir, "sessions", "session.jsonl")}' 2>/dev/null || true; printf ':end'`,
		setup: async ({ agentDir }) => {
			await mkdir(join(agentDir, "sessions"), { recursive: true });
			await writeFile(join(agentDir, "auth.json"), `${secret}\n`, "utf8");
			await writeFile(join(agentDir, "sessions", "session.jsonl"), `${secret}\n`, "utf8");
		},
	});
	assert.equal(bashResult.toolEnd.isError, false);
	assert.doesNotMatch(bashResult.resultText, new RegExp(secret));
	assert.match(bashResult.resultText, /auth::sessions::end/);
});

test("Sandburg bash hides the real agent dir when agent bin is a symlink", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const secret = "secret-agent-bin-symlink-state";
	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash-agent-bin-symlink",
		command: ({ agentDir }) => `printf 'auth:'; cat '${join(agentDir, "auth.json")}' 2>/dev/null || true; printf ':end'`,
		setup: async ({ cwd, agentDir }) => {
			const externalBinRoot = join(cwd, "external-agent-bin-root");
			const externalBin = join(externalBinRoot, "bin");
			await mkdir(externalBin, { recursive: true });
			await symlink(externalBin, join(agentDir, "bin"), "dir");
			await writeFile(join(agentDir, "auth.json"), `${secret}\n`, "utf8");
		},
	});
	assert.equal(bashResult.toolEnd.isError, false);
	assert.doesNotMatch(bashResult.resultText, new RegExp(secret));
	assert.match(bashResult.resultText, /auth::end/);
});

test("Sandburg bash cannot read SANDBURG_PRIVATE_PATHS", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const secret = "secret-private-extra-path";
	let privateDir;
	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash-private-paths",
		command: () => `printf 'private-paths:%s:secret:' "\${SANDBURG_PRIVATE_PATHS-unset}"; cat '${join(privateDir, "secret.txt")}' 2>/dev/null || true; printf ':end'`,
		setup: async ({ cwd }) => {
			privateDir = join(cwd, "private-state");
			await mkdir(privateDir, { recursive: true });
			await writeFile(join(privateDir, "secret.txt"), `${secret}\n`, "utf8");
		},
		env: () => ({ SANDBURG_PRIVATE_PATHS: privateDir }),
	});
	assert.equal(bashResult.toolEnd.isError, false);
	assert.doesNotMatch(bashResult.resultText, new RegExp(secret));
	assert.match(bashResult.resultText, /private-paths:unset:secret::end/);
});
