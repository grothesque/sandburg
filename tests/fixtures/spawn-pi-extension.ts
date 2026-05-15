// Test extension that launches a child `pi` command through inherited PATH

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";

function parseArgs(): string[] {
	const raw = process.env.SANDBURG_TEST_SPAWN_PI_ARGS_JSON;
	if (!raw) return ["--no-extensions", "--mode", "json", "spawn-pi-probe"];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
		throw new Error("SANDBURG_TEST_SPAWN_PI_ARGS_JSON must be a JSON string array");
	}
	return parsed;
}

function recordSpawnResult(result: ReturnType<typeof spawnSync>) {
	const recordPath = process.env.SANDBURG_TEST_SPAWN_PI_RECORD;
	if (!recordPath) return;

	writeFileSync(
		recordPath,
		JSON.stringify(
			{
				status: result.status,
				signal: result.signal,
				stdout: result.stdout,
				stderr: result.stderr,
				error: result.error ? { name: result.error.name, message: result.error.message } : undefined,
			},
			null,
			2,
		),
		"utf8",
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("spawn-pi-probe", {
		description: "Test helper: spawn a child pi command through PATH",
		handler: async () => {
			const args = parseArgs();
			const result = spawnSync("pi", args, {
				env: process.env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: Number(process.env.SANDBURG_TEST_SPAWN_PI_TIMEOUT_MS ?? "5000"),
			});
			recordSpawnResult(result);

			if (result.error) throw result.error;
			if (result.status !== 0) {
				throw new Error(`child pi exited with status ${result.status}; stderr: ${result.stderr}`);
			}
		},
	});
}
