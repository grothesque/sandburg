import { spawnSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PATH, mkTestDir, rmTestDir } from "./helpers/test-env.mjs";
import { createSandburgSdkSession } from "./helpers/pi-sdk-harness.mjs";

const TOOL_SANDBOX_RUNNER_MARKER = "# sandburg-extension-managed: tool-sandbox-runner";
const RG_WRAPPER_MARKER = "# sandburg-extension-managed: rg-wrapper";

function realRgPath() {
	const result = spawnSync("sh", ["-c", "command -v rg"], {
		env: { PATH: DEFAULT_PATH },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 3000,
	});
	if (result.status !== 0) return undefined;
	return realpathSync(result.stdout.trim());
}

test("Sandburg installs managed helper executables", async (t) => {
	const realRg = realRgPath();
	if (!realRg) {
		t.skip("rg is unavailable on the stable test PATH");
		return;
	}

	const dir = await mkTestDir("sandburg-helper-install");
	let harness;
	try {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		const agentBinDir = join(agentDir, "bin");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentBinDir, { recursive: true });

		harness = await createSandburgSdkSession({
			cwd,
			agentDir,
			env: { PATH: `${agentBinDir}:${DEFAULT_PATH}` },
			responses: [],
		});

		assert.deepEqual(harness.extensionsResult.errors, []);

		const sandboxRunnerPath = join(agentBinDir, "sandburg-tool-sandbox");
		const rgWrapperPath = join(agentBinDir, "rg");
		const sandboxRunner = await readFile(sandboxRunnerPath, "utf8");
		const rgWrapper = await readFile(rgWrapperPath, "utf8");

		assert.match(sandboxRunner, new RegExp(TOOL_SANDBOX_RUNNER_MARKER));
		assert.match(rgWrapper, new RegExp(RG_WRAPPER_MARKER));
		assert.match(rgWrapper, new RegExp(realRg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		await access(sandboxRunnerPath, constants.X_OK);
		await access(rgWrapperPath, constants.X_OK);

		const wrapperVersion = spawnSync(rgWrapperPath, ["--version"], {
			env: { PATH: `${agentBinDir}:${DEFAULT_PATH}` },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 3000,
		});
		assert.equal(wrapperVersion.status, 0, wrapperVersion.stderr);
		assert.match(wrapperVersion.stdout, /^ripgrep /);
	} finally {
		harness?.dispose();
		await rmTestDir(dir);
	}
});
