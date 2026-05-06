/**
 * Development-only helpers for manually testing Pi tool registration and activation.
 *
 * Use /tooltester-add for runtime fake tools. Use /tooltester-write-preload
 * to write a project-local fake-tool extension that can be loaded before another
 * extension when testing tool shadowing and load order.
 * This is a development helper, not a normally installed extension.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Type } from "typebox";

const PRELOAD_EXTENSION_PATH = ".pi/extensions/000-tooltester-preload.ts";

function words(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string, type: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

function setToolsEnabled(pi: ExtensionAPI, names: string[], enabled: boolean) {
	const active = new Set(pi.getActiveTools());
	for (const name of names) {
		if (enabled) active.add(name);
		else active.delete(name);
	}
	pi.setActiveTools([...active]);
}

function sourceSummary(sourceInfo: ReturnType<ExtensionAPI["getAllTools"]>[number]["sourceInfo"]): string {
	return `${sourceInfo.source} ${sourceInfo.path}`;
}

function fakeToolRegistrationSource(names: string[]): string {
	return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\nimport { Type } from "typebox";\n\nconst toolNames = ${JSON.stringify(names)};\n\nexport default function (pi: ExtensionAPI) {\n\tfor (const name of toolNames) {\n\t\tpi.registerTool({\n\t\t\tname,\n\t\t\tlabel: name,\n\t\t\tdescription: "Preloaded fake " + name + " tool for Pi tool testing.",\n\t\t\tpromptSnippet: \"Fake tool registered by tooltester; returns a diagnostic text response.\",\n\t\t\tparameters: Type.Object({}, { additionalProperties: true }),\n\t\t\tasync execute() {\n\t\t\t\treturn {\n\t\t\t\t\tcontent: [{ type: \"text\", text: \"tooltester fake tool response\" }],\n\t\t\t\t\tdetails: { from: \"tooltester-preload\", tool: name },\n\t\t\t\t};\n\t\t\t},\n\t\t});\n\t}\n\n\tpi.on(\"session_start\", () => {\n\t\tpi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])]);\n\t});\n}\n`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tooltester-add", {
		description: "Test helper: register and enable a fake new TOOL",
		handler: async (args, ctx) => {
			const [name, ...extra] = words(args);
			if (!name || extra.length > 0) {
				notify(ctx, "Usage: /tooltester-add TOOL", "warning");
				return;
			}

			const existing = pi.getAllTools().find((tool) => tool.name === name);
			if (existing) {
				notify(
					ctx,
					[
						`Tool already exists: ${name}`,
						"Runtime registration cannot override an earlier tool with the same name.",
						`Use /tooltester-write-preload ${name}, then reload with the generated extension before the extension under test to test a replacement.`,
					].join("\n"),
					"warning",
				);
				return;
			}

			pi.registerTool({
				name,
				label: name,
				description: `Fake ${name} tool for Pi tool testing.`,
				promptSnippet: "Fake tool registered by tooltester; returns a diagnostic text response.",
				parameters: Type.Object({}, { additionalProperties: true }),
				async execute() {
					return {
						content: [{ type: "text", text: "tooltester fake tool response" }],
						details: { from: "tooltester", tool: name },
					};
				},
			});

			setToolsEnabled(pi, [name], true);
			notify(ctx, `Registered and enabled fake tool: ${name}`);
		},
	});

	pi.registerCommand("tooltester-write-preload", {
		description: "Test helper: write a project-local fake-tool preload extension",
		handler: async (args, ctx) => {
			const names = words(args);
			if (names.length === 0) {
				notify(ctx, "Usage: /tooltester-write-preload TOOL [TOOL...]", "warning");
				return;
			}

			const path = join(ctx.cwd, PRELOAD_EXTENSION_PATH);
			mkdirSync(join(ctx.cwd, ".pi/extensions"), { recursive: true });
			writeFileSync(path, fakeToolRegistrationSource(names), "utf-8");
			notify(
				ctx,
				[
					`Wrote ${PRELOAD_EXTENSION_PATH} with fake tools: ${names.join(", ")}`,
					"To shadow an existing tool, load the generated extension before the extension under test.",
					"If the extension under test was loaded with -e/--extension, /reload may not change CLI extension order.",
					"Restart pi with the generated preload path before the extension under test, for example:",
					`  pi -e ./${PRELOAD_EXTENSION_PATH} -e ./path/to/extension-under-test -e ./dev-extensions/tooltester.ts`,
					"Then run /tooltester-list and the status or verification command you are testing.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("tooltester-enable", {
		description: "Test helper: enable one or more tools",
		handler: async (args, ctx) => {
			const names = words(args);
			if (names.length === 0) {
				notify(ctx, "Usage: /tooltester-enable TOOL [TOOL...]", "warning");
				return;
			}
			setToolsEnabled(pi, names, true);
			notify(ctx, `Enabled tools: ${names.join(", ")}`);
		},
	});

	pi.registerCommand("tooltester-disable", {
		description: "Test helper: disable one or more tools",
		handler: async (args, ctx) => {
			const names = words(args);
			if (names.length === 0) {
				notify(ctx, "Usage: /tooltester-disable TOOL [TOOL...]", "warning");
				return;
			}
			setToolsEnabled(pi, names, false);
			notify(ctx, `Disabled tools: ${names.join(", ")}`);
		},
	});

	pi.registerCommand("tooltester-list", {
		description: "Test helper: list tools, activation state, and sources",
		handler: async (_args, ctx) => {
			const active = new Set(pi.getActiveTools());
			const lines = pi
				.getAllTools()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((tool) => `- ${active.has(tool.name) ? "enabled " : "disabled"} ${tool.name}: ${sourceSummary(tool.sourceInfo)}`);
			notify(ctx, ["tooltester tools", ...lines].join("\n"));
		},
	});

	pi.registerCommand("tooltester-reset", {
		description: "Test helper: remove generated preload extension and reload pi",
		handler: async (_args, ctx) => {
			rmSync(join(ctx.cwd, PRELOAD_EXTENSION_PATH), { force: true });
			notify(ctx, "Removed generated preload extension. Reloading to clear runtime fake tool registrations...");
			await ctx.reload();
			return;
		},
	});
}
