// Basic protected-path policy tests

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { assertFileNotExists, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

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
	return runSandburgToolCall({ cwd, agentDir, toolName, args });
}

test("Sandburg read denies Pi credentials", async () => {
	const authPath = join(agentDir, "auth.json");
	await writeFile(authPath, "sensitive credentials", "utf8");

	const { toolEnd, resultText } = await runToolCall("read", { path: authPath });

	assert.equal(toolEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /protected Pi credential\/cache path/);
});

test("Sandburg write denies Pi agent directory", async () => {
	const blockedPath = join(agentDir, "blocked-write.txt");

	const { toolEnd, resultText } = await runToolCall("write", {
		path: blockedPath,
		content: "should not be written",
	});

	assert.equal(toolEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /protected Pi state\/cache path/);
	await assertFileNotExists(blockedPath);
});

test("Sandburg allows project writes", async () => {
	const allowedPath = join(cwd, "allowed-write.txt");

	const { toolEnd } = await runToolCall("write", {
		path: "allowed-write.txt",
		content: "allowed project content",
	});

	assert.equal(toolEnd.isError, false);
	assert.equal(await readFile(allowedPath, "utf8"), "allowed project content");
});
