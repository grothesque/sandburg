// Trusted extension key tests

import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function importStatus() {
	return await jiti.import("../extensions/sandburg/status.ts");
}

function sourceInfo(overrides) {
	return {
		path: "/tmp/pi-extensions/npm/hash/node_modules/pi-subagents/extensions/index.ts",
		source: "npm:pi-subagents",
		scope: "temporary",
		origin: "package",
		baseDir: "/tmp/pi-extensions/npm/hash/node_modules/pi-subagents",
		...overrides,
	};
}

function mockPi(tools, activeTools = tools.map((tool) => tool.name)) {
	return {
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
	};
}

async function withTrustedExtensions(value, fn) {
	const saved = process.env.SANDBURG_TRUSTED_EXTENSIONS;
	try {
		process.env.SANDBURG_TRUSTED_EXTENSIONS = value;
		await fn();
	} finally {
		if (saved === undefined) delete process.env.SANDBURG_TRUSTED_EXTENSIONS;
		else process.env.SANDBURG_TRUSTED_EXTENSIONS = saved;
	}
}

test("package extension trust keys use Pi's package source string", async () => {
	const status = await importStatus();
	const pi = mockPi([{ name: "subagent", sourceInfo: sourceInfo({}) }]);

	await withTrustedExtensions("npm:pi-subagents", () => {
		const [record] = status.getAdditionalActiveToolRecords(pi);
		assert.equal(record.trust.key, "npm:pi-subagents");
		assert.equal(record.trust.trusted, true);
	});
});

test("non-package extension trust keys use Pi's extension path", async () => {
	const status = await importStatus();
	const localPath = "/home/me/src/extension/extensions/tool.ts";
	const pi = mockPi([
		{
			name: "local_tool",
			sourceInfo: sourceInfo({
				path: localPath,
				source: "local",
				origin: "top-level",
				baseDir: "/home/me/src/extension/extensions",
			}),
		},
	]);

	await withTrustedExtensions(localPath, () => {
		const [record] = status.getAdditionalActiveToolRecords(pi);
		assert.equal(record.trust.key, localPath);
		assert.equal(record.trust.trusted, true);
	});

	await withTrustedExtensions("/home/me/src/extension", () => {
		const [record] = status.getAdditionalActiveToolRecords(pi);
		assert.equal(record.trust.key, localPath);
		assert.equal(record.trust.trusted, false);
	});
});

test("Sandburg warning ignores trusted additional active tools", async () => {
	const status = await importStatus();
	const pi = mockPi([
		{ name: "read", sourceInfo: sourceInfo({ path: "<builtin:read>", source: "builtin", origin: "top-level" }) },
		{ name: "subagent", sourceInfo: sourceInfo({}) },
		{ name: "deploy", sourceInfo: sourceInfo({ path: "/home/me/deploy.ts", source: "local", origin: "top-level", baseDir: "/home/me" }) },
	]);

	await withTrustedExtensions("npm:pi-subagents", () => {
		const warning = status.getAdditionalActiveToolsWarning(pi);
		assert.match(warning, /deploy/);
		assert.doesNotMatch(warning, /subagent/);

		const trustedOnlyPi = mockPi([{ name: "subagent", sourceInfo: sourceInfo({}) }]);
		assert.equal(status.getAdditionalActiveToolsWarning(trustedOnlyPi), undefined);
	});
});

test("trusted extension keys are comma-separated exact strings", async () => {
	const status = await importStatus();
	const pi = mockPi([
		{ name: "npm_a", sourceInfo: sourceInfo({ source: "npm:a" }) },
		{ name: "local", sourceInfo: sourceInfo({ path: "/tmp/ext.ts", source: "local", origin: "top-level" }) },
		{ name: "npm_b", sourceInfo: sourceInfo({ source: "npm:b" }) },
	]);

	await withTrustedExtensions(" npm:a, /tmp/ext.ts ,, npm:b ", () => {
		const records = status.getAdditionalActiveToolRecords(pi);
		assert.deepEqual(records.map((record) => [record.name, record.trust.trusted]), [
			["local", true],
			["npm_a", true],
			["npm_b", true],
		]);
	});
});
