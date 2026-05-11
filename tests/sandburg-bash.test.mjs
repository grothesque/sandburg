import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventsOfType, findToolEnd, lastAssistantText, toolResultText } from "./helpers/events.mjs";
import { bwrapUsable, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { assistantText, assistantToolCall, createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

async function runBashToolCall({ dirName, command, setup }) {
	const dir = await mkTestDir(dirName);
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await setup?.({ cwd, agentDir });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			responses: [
				assistantToolCall("bash", { command, timeout: 2 }),
				assistantText("done"),
			],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const events = await harness.prompt("run bash");
		const bashStarts = eventsOfType(events, "tool_execution_start").filter((event) => event.toolName === "bash");
		const bashEnd = findToolEnd(events, "bash");

		assert.equal(bashStarts.length, 1);
		assert.ok(bashEnd, "expected a bash tool_execution_end event");
		assert.equal(lastAssistantText(events), "done");
		return bashEnd;
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
}

test("Sandburg bash tool runs inside the tool sandbox", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const bashEnd = await runBashToolCall({
		dirName: "sandburg-bash",
		command: "printf 'sandbox:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
	});

	assert.equal(bashEnd.isError, false);
	assert.match(toolResultText(bashEnd), /sandbox:1/);
});

test("Sandburg bash cannot read Pi credentials", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const secret = "secret-token-visible-without-sandbox";
	const bashEnd = await runBashToolCall({
		dirName: "sandburg-bash-auth",
		command: "printf 'auth:'; cat \"$SANDBURG_AUTH_PATH\"; printf ':end'",
		setup: async ({ agentDir }) => {
			await writeFile(join(agentDir, "auth.json"), `${secret}\n`, "utf8");
		},
	});
	const resultText = toolResultText(bashEnd);

	assert.equal(bashEnd.isError, false);
	assert.doesNotMatch(resultText, new RegExp(secret));
	assert.match(resultText, /auth::end/);
});
