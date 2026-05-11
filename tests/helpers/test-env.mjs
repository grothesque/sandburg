// Test environment helpers and hermetic subprocess setup

import { access, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

function executablePath(path) {
	try {
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

export function piBinPath() {
	if (process.env.PI_BIN) return executablePath(process.env.PI_BIN);

	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = executablePath(join(dir, "pi"));
		if (candidate) return candidate;
	}

	return undefined;
}

export function piSubprocessEnv({ piBin, agentDir, home, extra = {} } = {}) {
	if (!piBin) throw new Error("piSubprocessEnv requires piBin");
	if (!agentDir) throw new Error("piSubprocessEnv requires agentDir");

	const env = {
		PATH: `${DEFAULT_PATH}${delimiter}${dirname(piBin)}`,
		HOME: home ?? agentDir,
		LANG: "C.UTF-8",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
	};

	// Pi normally finds its package assets from the executable path. Preserve this
	// explicit override for package-manager layouts that need it, without passing
	// the user’s entire environment into subprocess tests.
	if (process.env.PI_PACKAGE_DIR) env.PI_PACKAGE_DIR = process.env.PI_PACKAGE_DIR;

	return { ...env, ...extra };
}

export function bwrapUsable() {
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

function safeName(name) {
	return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function mkTestDir(name = "test") {
	return mkdtemp(join(tmpdir(), `sandburg-${safeName(name)}-`));
}

export async function rmTestDir(path) {
	await rm(path, { recursive: true, force: true });
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
