import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	assertFileExists,
	assertFileNotExists,
	mkTestDir,
	repoRoot,
	rmTestDir,
	sandburgExtensionPath,
} from "./helpers/test-env.mjs";

test("test helpers expose repository paths", async () => {
	await assertFileExists(join(repoRoot(), "README.md"));
	await assertFileExists(join(sandburgExtensionPath(), "index.ts"));
});

test("test helpers create isolated temp dirs", async () => {
	const dir = await mkTestDir("smoke");
	try {
		await assertFileExists(dir);

		const present = join(dir, "present.txt");
		const absent = join(dir, "absent.txt");
		await writeFile(present, "ok");
		await assertFileExists(present);
		await assertFileNotExists(absent);
	} finally {
		await rmTestDir(dir);
	}
});
