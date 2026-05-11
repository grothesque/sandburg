// SDK/faux-provider harness smoke test

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { lastAssistantText } from "./helpers/events.mjs";
import { mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { assistantText, createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

test("SDK harness drives a faux-model session", async () => {
	const dir = await mkTestDir("sdk-harness");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [assistantText("ok")],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt("hello");
		assert.ok(events.some((event) => event.type === "agent_end"));
		assert.equal(lastAssistantText(events), "ok");
		assert.equal(harness.faux.getPendingResponseCount(), 0);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});
