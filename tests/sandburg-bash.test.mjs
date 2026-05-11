import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventsOfType, findToolEnd, lastAssistantText, toolResultText } from "./helpers/events.mjs";
import { DEFAULT_PATH, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { assistantText, assistantToolCall, createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

function bwrapUsable() {
	const result = spawnSync(
		"bwrap",
		[
			"--unshare-all",
			"--die-with-parent",
			"--new-session",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"/bin/true",
		],
		{
			env: { PATH: DEFAULT_PATH },
			stdio: "ignore",
			timeout: 5000,
		},
	);
	return result.status === 0;
}

test("Sandburg bash tool runs inside the tool sandbox", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const dir = await mkTestDir("sandburg-bash");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [
				assistantToolCall("bash", {
					command: "printf 'sandbox:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
					timeout: 2,
				}),
				assistantText("done"),
			],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt("run the bash sandbox smoke test");
		const bashStarts = eventsOfType(events, "tool_execution_start").filter((event) => event.toolName === "bash");
		const bashEnd = findToolEnd(events, "bash");

		assert.equal(bashStarts.length, 1);
		assert.ok(bashEnd, "expected a bash tool_execution_end event");
		assert.equal(bashEnd.isError, false);
		assert.match(toolResultText(bashEnd), /sandbox:1/);
		assert.equal(lastAssistantText(events), "done");
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});
