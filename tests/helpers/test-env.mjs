import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
export const DEFAULT_PATH = "/usr/bin:/bin";

export function repoRoot() {
	return REPO_ROOT;
}

export function sandburgExtensionPath() {
	return join(REPO_ROOT, "extensions", "sandburg");
}

function safeName(name) {
	return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function mkTestDir(name = "test") {
	return mkdtemp(join(tmpdir(), `sandburg-${safeName(name)}-`));
}

export async function rmTestDir(path) {
	await rm(path, { recursive: true, force: true });
}

export async function makeTestEnv(extra = {}) {
	const agentDir = extra.PI_CODING_AGENT_DIR ?? (await mkTestDir("agent"));
	return {
		...process.env,
		PATH: DEFAULT_PATH,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		...extra,
	};
}

export async function assertFileExists(path) {
	await access(path, constants.F_OK);
}

export async function assertFileNotExists(path) {
	try {
		await access(path, constants.F_OK);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Expected file not to exist: ${path}`);
}
