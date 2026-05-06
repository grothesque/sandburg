/**
 * sandburg: Pi extension for sandboxing agent-facing tools
 *
 * - bash and grep subprocesses run through sandburg-bwrap with network disabled.
 * - read/write/edit are re-registered with path guards for Pi credentials/state.
 * - /sandburg reports protected tools and outer sandbox exposure signals.
 *
 * Extensions are trusted code; this protects against tool misuse and launch/config
 * oversights, not against adversarial same-user code or malicious extensions.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
	ACTIVE_MARKER,
	AGENT_DIR,
	AUTH_JSON_PATH,
	BWRAP_PATH,
	installSandburgHelpers,
	shQuote,
	verifyPiGrepReachesRgWrapper,
} from "./helpers.js";
import { registerGuardedMutationToolDefinition, registerGuardedReadToolDefinition } from "./path-policy.js";
import {
	buildSandburgStatus,
	checkSandburgToolContract,
	getAdditionalActiveToolNames,
	type SandburgToolContractStatus,
} from "./status.js";

const SANDBOXED_BASH_DESCRIPTION =
	"Execute a bash command in the current working directory inside a sandbox with network access disabled. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const SANDBOXED_BASH_PROMPT_SNIPPET = "Execute bash commands (ls, grep, find, etc.) inside a sandbox with network access disabled";
const SANDBOXED_BASH_PROMPT_GUIDELINES = [
	"The `bash` tool runs inside a sandbox with network access disabled. Commands that require network access will fail, including downloading files, fetching from package registries, git fetch/pull, and similar operations.",
	"This deliberate network blocking should never make you work around recommended workflows. Instead, ask the user to run any needed command and say whether you need to see the output. For example, ask the user to run `cargo add` instead of guessing the appropriate version of the dependency and manually adding it to `Cargo.toml`.",
];

export default async function (pi: ExtensionAPI) {
	installSandburgHelpers();
	await verifyPiGrepReachesRgWrapper();

	let toolContractStatus: SandburgToolContractStatus = { valid: true, violations: [] };
	let disabledAllTools = false;

	process.env.SANDBURG_ACTIVE = ACTIVE_MARKER;
	process.env.SANDBURG_AGENT_DIR = AGENT_DIR;
	process.env.SANDBURG_AUTH_PATH = AUTH_JSON_PATH;

	pi.on("session_shutdown", () => {
		if (process.env.SANDBURG_ACTIVE === ACTIVE_MARKER) delete process.env.SANDBURG_ACTIVE;
		if (process.env.SANDBURG_AGENT_DIR === AGENT_DIR) delete process.env.SANDBURG_AGENT_DIR;
		if (process.env.SANDBURG_AUTH_PATH === AUTH_JSON_PATH) delete process.env.SANDBURG_AUTH_PATH;
	});

	let registeredCwd: string | undefined;

	const registerSandburgTools = (localCwd: string) => {
		if (registeredCwd === localCwd) return;
		registeredCwd = localCwd;

		const readDefinition = {
			...createReadToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		const writeDefinition = {
			...createWriteToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		const editDefinition = {
			...createEditToolDefinition(localCwd),
			executionMode: "sequential" as const,
		};
		// Use ToolDefinition factories when re-registering built-ins in an extension;
		// create*Tool() returns lower-level AgentTool wrappers without Pi renderers.
		const sandburgBashDefinition = createBashToolDefinition(localCwd, {
			spawnHook: ({ command, cwd, env }) => {
				return {
					command: `exec ${shQuote(BWRAP_PATH)} /bin/bash -c ${shQuote(command)}`,
					cwd,
					env: {
						...env,
						SANDBURG_ACTIVE: ACTIVE_MARKER,
						SANDBURG_AGENT_DIR: AGENT_DIR,
						SANDBURG_AUTH_PATH: AUTH_JSON_PATH,
					},
				};
			},
		});

		Object.assign(sandburgBashDefinition, {
			name: "bash",
			label: "bash",
			description: SANDBOXED_BASH_DESCRIPTION,
			promptSnippet: SANDBOXED_BASH_PROMPT_SNIPPET,
			promptGuidelines: SANDBOXED_BASH_PROMPT_GUIDELINES,
		});

		pi.registerTool(sandburgBashDefinition);
		registerGuardedReadToolDefinition(pi, readDefinition, localCwd);
		registerGuardedMutationToolDefinition(pi, writeDefinition, localCwd);
		registerGuardedMutationToolDefinition(pi, editDefinition, localCwd);
	};

	const checkToolContract = (notify?: (message: string) => void) => {
		const status = checkSandburgToolContract(pi);
		if (!status.valid) {
			pi.setActiveTools([]);
			toolContractStatus = status;
			disabledAllTools = true;
			notify?.("Sandburg tool contract is invalid, so all tools are disabled.\nRun /sandburg for details.\n");
			return;
		}
		toolContractStatus = status;
		disabledAllTools = false;
	};

	// This is intentionally a load/reload-time warning, not a hard contract
	// failure and not a per-tool-call gate. Under Pi’s current same-name tool
	// de-duplication semantics, later-loaded extensions cannot replace
	// sandburg’s protected tool replacements after the contract check passes.
	// Dynamic runtime tool registration is trusted user extension behavior. This
	// warning is meant to catch forgotten extensions in the load path, while
	// keeping intentionally enabled tools usable.
	const warnAboutAdditionalActiveTools = (notify?: (message: string) => void) => {
		if (!toolContractStatus.valid) return;
		const names = getAdditionalActiveToolNames(pi);
		if (names.length === 0) return;
		notify?.(`Additional tools are active outside the sandburg contract: ${names.join(", ")}. They remain enabled. Run /sandburg for details.\n`);
	};

	pi.registerCommand("sandburg", {
		description: "Show sandburg sandbox status",
		handler: async (_args, ctx) => {
			checkToolContract();
			const status = buildSandburgStatus(pi, toolContractStatus, disabledAllTools);
			if (ctx.hasUI) ctx.ui.notify(status.text, status.severity);
			else console.log(status.text);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		registerSandburgTools(ctx.cwd);
		checkToolContract((message) => ctx.ui.notify(message, "warning"));
		warnAboutAdditionalActiveTools((message) => ctx.ui.notify(message, "warning"));
	});

	pi.on("before_agent_start", async () => {
		if (!toolContractStatus.valid) {
			pi.setActiveTools([]);
			disabledAllTools = true;
		}
	});

	pi.on("tool_call", async () => {
		if (!toolContractStatus.valid) {
			return { block: true, reason: "sandburg tool contract is invalid; all tools are disabled." };
		}
	});
}
