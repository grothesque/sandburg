/**
 * sandburg: Pi extension for sandboxing agent-facing tools
 *
 * - bash and grep subprocesses run through the tool sandbox runner with network disabled.
 * - read/write/edit are re-registered with path guards for private Pi/Sandburg state.
 * - /sandburg reports protected tools and outer sandbox exposure signals.
 *
 * Extensions are trusted code; this protects against tool misuse and launch/config
 * oversights, not against adversarial same-user code or malicious extensions.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_MARKER,
	ensurePathEntryFirst,
	findFirstPiOnPath,
	installSandburgHelpers,
	installSandburgPiWrapper,
	isSandburgManagedPiWrapper,
	shQuote,
	verifyPiGrepReachesRgWrapper,
} from "./helpers.js";
import {
	AGENT_BIN_DIR,
	AGENT_DIR,
	SANDBURG_AGENT_DIR_ENV,
	SANDBURG_PRIVATE_PATHS_ENV,
	SANDBURG_PRIVATE_PATHS_VALUE,
	TOOL_SANDBOX_RUNNER_PATH,
} from "./private-roots.js";
import {
	registerGuardedEditToolDefinition,
	registerGuardedReadToolDefinition,
	registerGuardedWriteToolDefinition,
} from "./path-policy.js";
import {
	SANDBURG_EXTENSION_PATH_ENV,
	SANDBURG_REAL_PI_ARGS_JSON_ENV,
	SANDBURG_REAL_PI_COMMAND_ENV,
	claimActiveSandburgSession,
	claimSandburgProcessEnv,
	initializeSandburgRuntime,
	setPiWrapperPropagationState,
	type ActiveSessionHandle,
	type EnvOwnershipHandle,
	type SandburgRuntimeState,
} from "./runtime-state.js";
import { setupSdkPropagation } from "./sdk-propagation.js";
import {
	buildSandburgStatus,
	checkSandburgSetup,
	getAdditionalActiveToolsWarning,
	getOuterSandboxStartupWarnings,
	type SandburgCheckStatus,
	type SandburgStatus,
} from "./status.js";

const SANDBURG_TOOL_ENV = {
	SANDBURG_ACTIVE: ACTIVE_MARKER,
	[SANDBURG_AGENT_DIR_ENV]: AGENT_DIR,
	[SANDBURG_PRIVATE_PATHS_ENV]: SANDBURG_PRIVATE_PATHS_VALUE,
};

const SANDBOXED_BASH_DESCRIPTION =
	"Execute a bash command in the current working directory inside a sandbox with network access disabled. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const SANDBOXED_BASH_PROMPT_SNIPPET = "Execute bash commands (ls, grep, find, etc.) inside a sandbox with network access disabled";
const SANDBOXED_BASH_PROMPT_GUIDELINES = [
	"The `bash` tool runs inside a sandbox with network access disabled. Commands that require network access will fail, including downloading files, fetching from package registries, git fetch/pull, and similar operations.",
	"This deliberate network blocking should never make you work around recommended workflows. Instead, ask the user to run any needed command and say whether you need to see the output. For example, ask the user to run `cargo add` instead of guessing the appropriate version of the dependency and manually adding it to `Cargo.toml`.",
];

type SandburgUiStatus = "active" | "warning" | "disabled";

function setSandburgUiStatus(ctx: ExtensionContext, status: SandburgUiStatus | undefined) {
	if (!ctx.hasUI) return;

	if (!status) {
		ctx.ui.setStatus("sandburg", undefined);
		return;
	}

	switch (status) {
		case "active":
			ctx.ui.setStatus("sandburg", `🟢 Sandburg ${ctx.ui.theme.fg("success", "active")}`);
			break;
		case "warning":
			ctx.ui.setStatus("sandburg", `🟠 Sandburg ${ctx.ui.theme.fg("warning", ctx.ui.theme.inverse(" WARNING "))} check /sandburg`);
			break;
		case "disabled":
			ctx.ui.setStatus("sandburg", `🔴 Sandburg ${ctx.ui.theme.fg("error", ctx.ui.theme.inverse(" DISABLED "))} check /sandburg`);
			break;
	}
}

function setPiWrapperNotPropagating(status: "disabled" | "unavailable", violations: string[]) {
	const firstPiOnPath = findFirstPiOnPath();
	setPiWrapperPropagationState({
		status,
		path: undefined,
		violations,
		pathUpdated: false,
		firstPiOnPath,
		firstPiOnPathManaged: isSandburgManagedPiWrapper(firstPiOnPath),
	});
}

function setupPiWrapperPropagation(runtimeState: SandburgRuntimeState): Record<string, string> {
	if (runtimeState.propagationDisable.disabled.has("pi-wrapper")) {
		setPiWrapperNotPropagating("disabled", []);
		return {};
	}

	if (!runtimeState.realPiInvocation) {
		setPiWrapperNotPropagating("unavailable", [runtimeState.realPiInvocationUnavailableReason ?? "valid real Pi CLI invocation was not captured"]);
		return {};
	}

	if (!runtimeState.resolvedSandburgExtensionPath) {
		setPiWrapperNotPropagating("unavailable", ["resolved Sandburg extension path was not captured"]);
		return {};
	}

	const installResult = installSandburgPiWrapper();
	if (installResult.status !== "installed") {
		const firstPiOnPath = findFirstPiOnPath();
		setPiWrapperPropagationState({
			status: "unavailable",
			path: installResult.path,
			violations: installResult.violations,
			pathUpdated: false,
			firstPiOnPath,
			firstPiOnPathManaged: isSandburgManagedPiWrapper(firstPiOnPath),
		});
		return {};
	}

	// Pi's built-in bash tool uses getShellEnv(), which includes the agent bin
	// directory for that tool subprocess. That does not mutate process.env.PATH,
	// so trusted extensions that spawn("pi", ..., { env: process.env }) would not
	// necessarily find Sandburg's wrapper. Put the managed wrapper directory first
	// in the inherited process environment for child-Pi propagation.
	const nextPath = ensurePathEntryFirst(process.env.PATH, AGENT_BIN_DIR);
	const firstPiOnPath = findFirstPiOnPath(nextPath.value);
	setPiWrapperPropagationState({
		status: "installed",
		path: installResult.path,
		violations: [],
		pathUpdated: nextPath.updated,
		firstPiOnPath,
		firstPiOnPathManaged: isSandburgManagedPiWrapper(firstPiOnPath),
	});

	return {
		PATH: nextPath.value,
		[SANDBURG_REAL_PI_COMMAND_ENV]: runtimeState.realPiInvocation.command,
		[SANDBURG_REAL_PI_ARGS_JSON_ENV]: JSON.stringify(runtimeState.realPiInvocation.argsPrefix),
		[SANDBURG_EXTENSION_PATH_ENV]: runtimeState.resolvedSandburgExtensionPath,
	};
}

export default async function (pi: ExtensionAPI) {
	const runtimeState = initializeSandburgRuntime(import.meta.url);
	setupSdkPropagation(runtimeState);

	const setupViolations = installSandburgHelpers();
	if (setupViolations.length === 0) setupViolations.push(...(await verifyPiGrepReachesRgWrapper()));

	let envHandle: EnvOwnershipHandle | undefined;
	const claimProcessEnv = () => {
		if (envHandle) return;
		envHandle = claimSandburgProcessEnv({
			...SANDBURG_TOOL_ENV,
			...setupPiWrapperPropagation(runtimeState),
		});
	};
	const releaseProcessEnv = () => {
		envHandle?.release();
		envHandle = undefined;
	};

	let sandburgStatus: SandburgCheckStatus = { valid: true, violations: [] };
	let toolsDisabledUntilReload = false;

	let activeSessionHandle: ActiveSessionHandle | undefined;
	const releaseActiveSession = () => {
		activeSessionHandle?.release();
		activeSessionHandle = undefined;
	};

	pi.on("session_shutdown", (_event, ctx) => {
		setSandburgUiStatus(ctx, undefined);
		releaseActiveSession();
		releaseProcessEnv();
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
					command: `exec ${shQuote(TOOL_SANDBOX_RUNNER_PATH)} /bin/bash -c ${shQuote(command)}`,
					cwd,
					env: {
						...env,
						...SANDBURG_TOOL_ENV,
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
		registerGuardedWriteToolDefinition(pi, writeDefinition, localCwd);
		registerGuardedEditToolDefinition(pi, editDefinition, localCwd);
	};

	const disableToolsUntilReload = (notify?: (message: string) => void) => {
		pi.setActiveTools([]);
		toolsDisabledUntilReload = true;
		notify?.("Sandburg setup is invalid, so all tools are disabled until /reload.\nRun /sandburg for details.\n");
	};

	const checkSandburg = (notify?: (message: string) => void) => {
		const status = checkSandburgSetup(pi, setupViolations);
		sandburgStatus = status;

		if (!status.valid) {
			disableToolsUntilReload(notify);
		}
	};

	const updateSandburgUiStatus = (ctx: ExtensionContext, status?: SandburgStatus) => {
		if (toolsDisabledUntilReload || !sandburgStatus.valid) {
			setSandburgUiStatus(ctx, "disabled");
			return;
		}

		const currentStatus = status ?? buildSandburgStatus(pi, sandburgStatus, toolsDisabledUntilReload);
		setSandburgUiStatus(ctx, currentStatus.severity === "warning" ? "warning" : "active");
	};

	// This is intentionally a load/reload-time warning, not a hard setup failure
	// and not a per-tool-call gate. Under Pi’s current same-name tool
	// de-duplication semantics, later-loaded extensions cannot replace
	// sandburg’s protected tool replacements after the setup check passes.
	// Dynamic runtime tool registration is trusted user extension behavior. This
	// warning is meant to catch forgotten extensions in the load path, while
	// keeping intentionally enabled tools usable.
	const warnAboutAdditionalActiveTools = (notify?: (message: string) => void) => {
		if (!sandburgStatus.valid) return;
		const additionalToolsWarning = getAdditionalActiveToolsWarning(pi);
		if (additionalToolsWarning) notify?.(`${additionalToolsWarning} Run /sandburg for details.\n`);
	};

	const warnAboutPiWrapperPropagation = (notify?: (message: string) => void) => {
		const piWrapper = runtimeState.piWrapperPropagation;
		if (piWrapper.status !== "unavailable") return;
		notify?.(`Nested Pi wrapper propagation is unavailable: ${piWrapper.violations.join("; ")}. Child Pi processes launched as \`pi\` may not load Sandburg. Run /sandburg for details.\n`);
	};

	const warnAboutSdkPropagation = (notify?: (message: string) => void) => {
		const sdkPropagation = runtimeState.sdkPropagation;
		if (sdkPropagation.status !== "unavailable") return;
		notify?.(`Nested Pi SDK session propagation is unavailable: ${sdkPropagation.violations.join("; ")}. SDK-created sessions may not load Sandburg. Run /sandburg for details.\n`);
	};

	let outerSandboxWarningsEmitted = false;
	const warnAboutOuterSandbox = (notify?: (message: string) => void) => {
		if (outerSandboxWarningsEmitted) return;
		outerSandboxWarningsEmitted = true;
		for (const warning of getOuterSandboxStartupWarnings()) notify?.(`${warning}\n`);
	};

	pi.registerCommand("sandburg", {
		description: "Show sandburg sandbox status",
		handler: async (_args, ctx) => {
			checkSandburg();
			const status = buildSandburgStatus(pi, sandburgStatus, toolsDisabledUntilReload);
			updateSandburgUiStatus(ctx, status);
			if (ctx.hasUI) ctx.ui.notify(status.text, status.severity === "success" ? "info" : status.severity);
			else console.log(status.text);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeSessionHandle ??= claimActiveSandburgSession();
		claimProcessEnv();
		registerSandburgTools(ctx.cwd);
		checkSandburg((message) => ctx.ui.notify(message, "warning"));
		updateSandburgUiStatus(ctx);
		warnAboutAdditionalActiveTools((message) => ctx.ui.notify(message, "warning"));
		warnAboutPiWrapperPropagation((message) => ctx.ui.notify(message, "warning"));
		warnAboutSdkPropagation((message) => ctx.ui.notify(message, "warning"));
		warnAboutOuterSandbox((message) => ctx.ui.notify(message, "warning"));
	});

	pi.on("before_agent_start", async () => {
		if (toolsDisabledUntilReload) {
			pi.setActiveTools([]);
		}
	});

	pi.on("tool_call", async () => {
		if (toolsDisabledUntilReload) {
			return { block: true, reason: "sandburg disabled all tools until /reload." };
		}
	});
}
