// Outer sandbox status wording tests

import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function importStatus() {
	return await jiti.import("../extensions/sandburg/status.ts");
}

test("missing outer sandbox warning points users to Sandkasten documentation", async () => {
	const status = await importStatus();
	const [warning] = status.getOuterSandboxStartupWarnings({
		namespaceSandboxDetected: false,
		hostWritableMounts: [],
		broadHostExposures: [],
	});

	assert.match(warning, /^No outer sandbox for the Pi process detected\./);
	assert.match(
		warning,
		/For effective protection, Sandburg must run inside Sandkasten or an equivalent outer sandbox\./,
	);
	assert.match(warning, /Consult the documentation:/);
	assert.match(warning, /README\.md/);
});
