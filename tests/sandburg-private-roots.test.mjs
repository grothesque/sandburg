// Private-root configuration tests

import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function importPrivateRootsWithEnv(value) {
	const previousValue = process.env.SANDBURG_PRIVATE_PATHS;
	try {
		process.env.SANDBURG_PRIVATE_PATHS = value;
		return await jiti.import("../extensions/sandburg/private-roots.ts");
	} finally {
		if (previousValue === undefined) delete process.env.SANDBURG_PRIVATE_PATHS;
		else process.env.SANDBURG_PRIVATE_PATHS = previousValue;
	}
}

test("SANDBURG_PRIVATE_PATHS rejects the filesystem root", async () => {
	const privateRoots = await importPrivateRootsWithEnv("/");

	assert.deepEqual(privateRoots.getExtraPrivatePathViolations(), [
		"SANDBURG_PRIVATE_PATHS entry #1 must not be /.",
	]);
});
