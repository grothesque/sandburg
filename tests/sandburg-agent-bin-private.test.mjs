// Symlinked agent-bin helper backing directory protection tests

import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { toolResultText } from "./helpers/events.mjs";
import { assertFileNotExists, bwrapUsable, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

async function withSymlinkedAgentBin(name, callback) {
	const dir = await mkTestDir(name);
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const externalBin = join(dir, "external-agent-bin");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await mkdir(externalBin, { recursive: true });
		await symlink(externalBin, join(agentDir, "bin"), "dir");
		await callback({ cwd, agentDir, externalBin });
	} finally {
		await rmTestDir(dir);
	}
}

test("Sandburg bash hides and protects symlinked agent-bin helper backing directory", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	await withSymlinkedAgentBin("sandburg-agent-bin-bash-private", async ({ cwd, agentDir, externalBin }) => {
		const helperPath = join(externalBin, "sandburg-tool-sandbox");
		const command = [
			`printf 'read:'`,
			`cat '${helperPath}' 2>/dev/null || true`,
			`printf ':write:'`,
			`(printf tampered > '${helperPath}') 2>/dev/null && printf wrote || printf blocked`,
			`printf ':end'`,
		].join("; ");

		const { toolEnd, resultText } = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "bash",
			args: { command, timeout: 2 },
			prompt: "run bash",
		});

		assert.equal(toolEnd.isError, false);
		assert.doesNotMatch(resultText, /sandburg-extension-managed/);
		assert.match(resultText, /read::write:blocked:end/);
		assert.notEqual(await readFile(helperPath, "utf8"), "tampered");
	});
});

test("Sandburg read/write/edit deny symlinked agent-bin helper backing directory", async () => {
	await withSymlinkedAgentBin("sandburg-agent-bin-policy-private", async ({ cwd, agentDir, externalBin }) => {
		const helperPath = join(externalBin, "sandburg-tool-sandbox");
		const writePath = join(externalBin, "write-tamper");

		const readResult = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "read",
			args: { path: helperPath },
		});
		assert.equal(readResult.toolEnd.isError, true);
		assert.match(toolResultText(readResult.toolEnd), /private Pi\/Sandburg state/);

		const writeResult = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "write",
			args: { path: writePath, content: "tampered" },
		});
		assert.equal(writeResult.toolEnd.isError, true);
		assert.match(toolResultText(writeResult.toolEnd), /private Pi\/Sandburg state/);
		await assertFileNotExists(writePath);

		const editResult = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "edit",
			args: { path: helperPath, edits: [{ oldText: "sandburg", newText: "tampered" }] },
		});
		assert.equal(editResult.toolEnd.isError, true);
		assert.match(toolResultText(editResult.toolEnd), /private Pi\/Sandburg state/);
	});
});
