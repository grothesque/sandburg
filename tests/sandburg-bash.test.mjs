import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventsOfType } from "./helpers/events.mjs";
import { bwrapUsable, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { runSandburgToolCall } from "./helpers/pi-sdk-harness.mjs";

async function runBashToolCall({ dirName, command, setup }) {
	const dir = await mkTestDir(dirName);
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await setup?.({ cwd, agentDir });

		const result = await runSandburgToolCall({
			cwd,
			agentDir,
			toolName: "bash",
			args: { command, timeout: 2 },
			prompt: "run bash",
		});
		const bashStarts = eventsOfType(result.events, "tool_execution_start").filter((event) => event.toolName === "bash");

		assert.equal(bashStarts.length, 1);
		return result;
	} finally {
		await rmTestDir(dir);
	}
}

test("Sandburg bash tool runs inside the tool sandbox", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash",
		command: "printf 'sandbox:%s' \"${SANDBURG_TOOL_SANDBOX:-unset}\"",
	});

	assert.equal(bashResult.toolEnd.isError, false);
	assert.match(bashResult.resultText, /sandbox:1/);
});

test("Sandburg bash cannot read Pi credentials", async (t) => {
	if (!bwrapUsable()) {
		t.skip("bwrap is unavailable or cannot create the sandbox in this environment");
		return;
	}

	const secret = "secret-token-visible-without-sandbox";
	const bashResult = await runBashToolCall({
		dirName: "sandburg-bash-auth",
		command: "printf 'auth:'; cat \"$SANDBURG_AUTH_PATH\"; printf ':end'",
		setup: async ({ agentDir }) => {
			await writeFile(join(agentDir, "auth.json"), `${secret}\n`, "utf8");
		},
	});
	assert.equal(bashResult.toolEnd.isError, false);
	assert.doesNotMatch(bashResult.resultText, new RegExp(secret));
	assert.match(bashResult.resultText, /auth::end/);
});
