import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { findToolEnd, lastAssistantText, toolResultText } from "./helpers/events.mjs";
import { assertFileNotExists, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { assistantText, assistantToolCall, createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

let dir;
let cwd;
let agentDir;

before(async () => {
	dir = await mkTestDir("sandburg-path-policy");
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
});

after(async () => {
	if (dir) await rmTestDir(dir);
});

async function runToolCall(toolName, args) {
	let harness;
	try {
		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [assistantToolCall(toolName, args), assistantText("done")],
		});
		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt(`run ${toolName}`);
		const toolEnd = findToolEnd(events, toolName);
		assert.ok(toolEnd, `expected a ${toolName} tool_execution_end event`);
		assert.equal(lastAssistantText(events), "done");
		return toolEnd;
	} finally {
		harness?.dispose();
	}
}

test("Sandburg read denies Pi credentials", async () => {
	const authPath = join(agentDir, "auth.json");
	await writeFile(authPath, "sensitive credentials", "utf8");

	const readEnd = await runToolCall("read", { path: authPath });
	const resultText = toolResultText(readEnd);

	assert.equal(readEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /protected Pi credential\/cache path/);
});

test("Sandburg write denies Pi agent directory", async () => {
	const blockedPath = join(agentDir, "blocked-write.txt");

	const writeEnd = await runToolCall("write", {
		path: blockedPath,
		content: "should not be written",
	});
	const resultText = toolResultText(writeEnd);

	assert.equal(writeEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /protected Pi state\/cache path/);
	await assertFileNotExists(blockedPath);
});

test("Sandburg allows project writes", async () => {
	const allowedPath = join(cwd, "allowed-write.txt");

	const writeEnd = await runToolCall("write", {
		path: "allowed-write.txt",
		content: "allowed project content",
	});

	assert.equal(writeEnd.isError, false);
	assert.equal(await readFile(allowedPath, "utf8"), "allowed project content");
});
