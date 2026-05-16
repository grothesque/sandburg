// Symlinks and SANDBURG_PRIVATE_PATHS tests

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { assertFileNotExists, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

let dir;
let cwd;
let agentDir;
let extraPrivateDir;

before(async () => {
	dir = await mkTestDir("sandburg-path-canonicalization");
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	extraPrivateDir = join(dir, "extra-private");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(extraPrivateDir, { recursive: true });
});

after(async () => {
	if (dir) await rmTestDir(dir);
});

async function runToolCall(toolName, args) {
	// Sandburg reads SANDBURG_PRIVATE_PATHS when its modules load, so keep
	// this file’s extra private path stable for every harness session.
	return runSandburgToolCall({
		cwd,
		agentDir,
		toolName,
		args,
		env: { SANDBURG_PRIVATE_PATHS: extraPrivateDir },
	});
}

test("Sandburg read denies symlinks to private Pi agent state", async () => {
	const authPath = join(agentDir, "auth.json");
	const authLinkPath = join(cwd, "auth-link.json");
	await writeFile(authPath, "sensitive credentials", "utf8");
	await symlink(authPath, authLinkPath);

	const { toolEnd, resultText } = await runToolCall("read", { path: "auth-link.json" });

	assert.equal(toolEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /private Pi\/Sandburg state/);
});

test("Sandburg edit denies symlink aliases into the Pi agent directory", async () => {
	const agentLinkPath = join(cwd, "agent-link");
	const blockedPath = join(agentDir, "blocked-via-link.txt");
	await symlink(agentDir, agentLinkPath);
	await writeFile(blockedPath, "original content", "utf8");

	const { toolEnd, resultText } = await runToolCall("edit", {
		path: "agent-link/blocked-via-link.txt",
		edits: [{ oldText: "original", newText: "modified" }],
	});

	assert.equal(toolEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /private Pi\/Sandburg state/);
	assert.equal(await readFile(blockedPath, "utf8"), "original content");
});

test("Sandburg write denies SANDBURG_PRIVATE_PATHS mutations", async () => {
	const blockedPath = join(extraPrivateDir, "blocked-extra-private.txt");

	const { toolEnd, resultText } = await runToolCall("write", {
		path: blockedPath,
		content: "should not be written",
	});

	assert.equal(toolEnd.isError, true);
	assert.match(resultText, /Access denied/);
	assert.match(resultText, /private Pi\/Sandburg state/);
	await assertFileNotExists(blockedPath);
});
