import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
	assertFileExists,
	assertFileNotExists,
	makeTestEnv,
	mkTestDir,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

test("test helpers expose repository paths", async () => {
	await assertFileExists(join(repoRoot(), "README.md"));
	await assertFileExists(join(sandburgExtensionPath(), "index.ts"));
});

test("test helpers create isolated temp dirs and env", async () => {
	const dir = await mkTestDir("smoke");
	try {
		await assertFileExists(dir);

		const present = join(dir, "present.txt");
		const absent = join(dir, "absent.txt");
		await writeFile(present, "ok");
		await assertFileExists(present);
		await assertFileNotExists(absent);

		const customAgentDir = join(dir, "agent");
		await mkdir(customAgentDir);
		const env = await makeTestEnv({ PI_CODING_AGENT_DIR: customAgentDir, EXTRA_TEST_VAR: "yes" });
		assert.equal(env.PI_CODING_AGENT_DIR, customAgentDir);
		assert.equal(env.PI_OFFLINE, "1");
		assert.equal(env.PATH, "/usr/bin:/bin");
		assert.equal(env.EXTRA_TEST_VAR, "yes");
	} finally {
		await rmTestDir(dir);
	}
});
