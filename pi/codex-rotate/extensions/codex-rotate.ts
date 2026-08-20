/**
 * codex-rotate — multi-account round-robin for OpenAI Codex (ChatGPT Plus/Pro).
 *
 * What it does:
 *  - Registers N extra `openai-codex-<i>` providers that clone the built-in
 *    openai-codex provider (same models, same OAuth flow, separate credentials
 *    in ~/.pi/agent/auth.json keyed by provider id).
 *  - Round-robins across logged-in accounts at session start.
 *  - On a rate-limit error mid-run, marks the account exhausted (cooldown),
 *    switches to the next available account, and re-sends the last prompt.
 *
 * Commands:
 *    /codex            status
 *    /codex accounts N set total number of Codex accounts (>= 1)
 *    /codex switch     rotate to the next available account now
 *    /codex cooldown M set cooldown minutes after a rate limit
 *
 * Login each extra account once with:  /login openai-codex-2  (etc.)
 *
 * State: ~/.pi/agent/agi-codex.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
	/** Total number of Codex accounts (account 1 = built-in `openai-codex`). */
	accounts: number;
	/** Cooldown minutes applied to an account after a rate-limit error. */
	cooldownMinutes: number;
	/** Round-robin pointer (0-based, into provider list). */
	rrIndex: number;
	/** providerId -> epoch ms when it was marked exhausted. */
	exhausted: Record<string, number>;
}

const STATE_PATH = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"agi-codex.json",
);

const DEFAULT_STATE: State = { accounts: 1, cooldownMinutes: 30, rrIndex: 0, exhausted: {} };

function loadState(): State {
	try {
		if (existsSync(STATE_PATH)) {
			return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
		}
	} catch {
		// corrupted state -> start fresh
	}
	return { ...DEFAULT_STATE };
}

function saveState(state: State): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const BASE_PROVIDER = "openai-codex";

function providerName(accountNo: number): string {
	return accountNo === 1 ? BASE_PROVIDER : `${BASE_PROVIDER}-${accountNo}`;
}

function providerNames(state: State): string[] {
	return Array.from({ length: Math.max(1, state.accounts) }, (_, i) => providerName(i + 1));
}

/** Clone the built-in codex provider under a new id. Credentials are keyed by
 *  provider id, so each clone gets its own OAuth tokens in auth.json. */
function cloneCodexProvider(base: Provider, accountNo: number): Provider {
	const id = providerName(accountNo);
	const models = (): readonly Model<Api>[] =>
		base.getModels().map((m) => ({
			...m,
			provider: id,
			name: `${m.name} (#${accountNo})`,
		}));
	return { ...base, id, name: `OpenAI Codex #${accountNo}`, getModels: models };
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
];

function isRateLimitError(message: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state = loadState();

	/** Built-in openai-codex provider from the bundled catalog. */
	const baseProvider: Provider | undefined = builtinProviders().find(
		(p) => p.id === BASE_PROVIDER,
	);
	const registered = new Set<string>();

	function ensureProviders(_ctx?: ExtensionContext): boolean {
		if (!baseProvider) return false;
		for (let n = 2; n <= state.accounts; n++) {
			const id = providerName(n);
			if (!registered.has(id)) {
				pi.registerProvider(cloneCodexProvider(baseProvider, n));
				registered.add(id);
			}
		}
		return true;
	}

	// Register clones at factory time so CLI --model/--list-models see them.
	ensureProviders();

	// -- helpers -------------------------------------------------------------

	function isCodexProvider(provider: string | undefined): boolean {
		return provider !== undefined && providerNames(state).includes(provider);
	}

	function pruneCooldowns(): void {
		const cooldownMs = state.cooldownMinutes * 60_000;
		const now = Date.now();
		let changed = false;
		for (const [id, at] of Object.entries(state.exhausted)) {
			if (now - at >= cooldownMs) {
				delete state.exhausted[id];
				changed = true;
			}
		}
		if (changed) saveState(state);
	}

	function availableProviders(ctx: ExtensionContext): string[] {
		pruneCooldowns();
		return providerNames(state).filter(
			(id) =>
				!(id in state.exhausted) && ctx.modelRegistry.getProviderAuthStatus(id).configured,
		);
	}

	/** Pick the next available provider after `from` in round-robin order. */
	function nextProvider(ctx: ExtensionContext, from?: string): string | undefined {
		const all = providerNames(state);
		const avail = availableProviders(ctx);
		if (avail.length === 0) return undefined;
		const start = from ? all.indexOf(from) : state.rrIndex - 1;
		for (let step = 1; step <= all.length; step++) {
			const candidate = all[(start + step + all.length) % all.length];
			if (avail.includes(candidate) && candidate !== from) return candidate;
		}
		return avail[0] !== from ? avail[0] : undefined;
	}

	async function switchTo(ctx: ExtensionContext, provider: string): Promise<boolean> {
		const current = ctx.model;
		if (!current) return false;
		const target = ctx.modelRegistry.find(provider, current.id);
		if (!target) return false;
		const ok = await pi.setModel(target);
		if (ok) {
			state.rrIndex = providerNames(state).indexOf(provider);
			saveState(state);
			updateStatus(ctx);
		}
		return ok;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const active = ctx.model?.provider;
		if (!isCodexProvider(active)) {
			ctx.ui.setStatus("codex-rotate", "");
			return;
		}
		const avail = availableProviders(ctx);
		const cooling = Object.keys(state.exhausted).length;
		let text = `codex ${active} | ${avail.length}/${state.accounts} available`;
		if (cooling > 0) text += ` | ${cooling} cooling down`;
		ctx.ui.setStatus("codex-rotate", text);
	}

	// -- rotation logic --------------------------------------------------------

	let lastUserPrompt: string | undefined;
	/** Providers already tried for the current prompt (loop guard). */
	let attempted = new Set<string>();
	let attemptedFor: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ensureProviders(ctx);
		// Per-session round-robin: if the active model is a Codex model, advance
		// to the next available account so consecutive sessions spread load.
		if (isCodexProvider(ctx.model?.provider) && state.accounts > 1) {
			const next = nextProvider(ctx, ctx.model!.provider);
			if (next && next !== ctx.model!.provider) {
				const ok = await switchTo(ctx, next);
				if (ok && ctx.hasUI) {
					ctx.ui.notify(`codex-rotate: using ${next} this session`, "info");
				}
			}
		}
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		lastUserPrompt = event.prompt;
		if (attemptedFor !== event.prompt) {
			attempted = new Set();
			attemptedFor = event.prompt;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = event.messages?.[event.messages.length - 1] as
			| { role?: string; stopReason?: string; errorMessage?: string }
			| undefined;
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return;
		if (!last.errorMessage || !isRateLimitError(last.errorMessage)) return;
		const current = ctx.model?.provider;
		if (!isCodexProvider(current)) return;

		// Mark the current account exhausted.
		state.exhausted[current!] = Date.now();
		saveState(state);
		attempted.add(current!);

		// Find a replacement we haven't tried for this prompt.
		let candidate = nextProvider(ctx, current);
		while (candidate && attempted.has(candidate)) {
			const remaining = availableProviders(ctx).filter((p) => !attempted.has(p));
			candidate = remaining[0];
		}
		if (!candidate) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`codex-rotate: all ${state.accounts} account(s) rate limited or untried-none-left. ` +
						`Cooldown is ${state.cooldownMinutes}m.`,
					"warning",
				);
			}
			updateStatus(ctx);
			return;
		}

		attempted.add(candidate);
		const ok = await switchTo(ctx, candidate);
		if (!ok) {
			updateStatus(ctx);
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(`codex-rotate: ${current} rate limited -> switched to ${candidate}, retrying`, "info");
		}
		if (lastUserPrompt) {
			pi.sendUserMessage(lastUserPrompt);
		}
	});

	// -- /codex command --------------------------------------------------------

	pi.registerCommand("codex", {
		description: "Codex multi-account rotation (status | accounts N | switch | cooldown M)",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "accounts", "switch", "cooldown"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, arg] = args.trim().split(/\s+/);
			switch ((sub || "status").toLowerCase()) {
				case "status": {
					pruneCooldowns();
					const lines = providerNames(state).map((id) => {
						const auth = ctx.modelRegistry.getProviderAuthStatus(id).configured;
						const cooling = state.exhausted[id];
						const active = ctx.model?.provider === id;
						const flags = [
							active ? "ACTIVE" : "",
							auth ? "logged in" : "not logged in (/login " + id + ")",
							cooling
								? `cooling (${Math.ceil((state.cooldownMinutes * 60_000 - (Date.now() - cooling)) / 60_000)}m left)`
								: "",
						]
							.filter(Boolean)
							.join(", ");
						return `  ${id}: ${flags}`;
					});
					ctx.ui.notify(
						`codex-rotate — ${state.accounts} account(s), cooldown ${state.cooldownMinutes}m\n` +
							lines.join("\n"),
						"info",
					);
					return;
				}
				case "accounts": {
					const n = Number.parseInt(arg ?? "", 10);
					if (!Number.isInteger(n) || n < 1 || n > 20) {
						ctx.ui.notify("Usage: /codex accounts <1-20>", "error");
						return;
					}
					const prev = state.accounts;
					state.accounts = n;
					saveState(state);
					if (!ensureProviders(ctx)) {
						ctx.ui.notify("codex-rotate: built-in openai-codex provider not found", "error");
						return;
					}
					for (let i = n + 1; i <= prev; i++) {
						pi.unregisterProvider(providerName(i));
						registered.delete(providerName(i));
					}
					ctx.ui.notify(
						`codex-rotate: ${n} account(s). Login new ones with /login ${providerName(Math.max(n, 2))} etc.`,
						"info",
					);
					updateStatus(ctx);
					return;
				}
				case "switch": {
					if (!isCodexProvider(ctx.model?.provider)) {
						ctx.ui.notify("Active model is not a Codex model.", "warning");
						return;
					}
					const next = nextProvider(ctx, ctx.model!.provider);
					if (!next) {
						ctx.ui.notify("No other available Codex account.", "warning");
						return;
					}
					const ok = await switchTo(ctx, next);
					ctx.ui.notify(
						ok ? `Switched to ${next}.` : `Could not switch to ${next} (not logged in?).`,
						ok ? "info" : "error",
					);
					return;
				}
				case "cooldown": {
					const m = Number.parseInt(arg ?? "", 10);
					if (!Number.isInteger(m) || m < 1) {
						ctx.ui.notify("Usage: /codex cooldown <minutes>", "error");
						return;
					}
					state.cooldownMinutes = m;
					saveState(state);
					ctx.ui.notify(`Cooldown set to ${m}m.`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /codex [status | accounts N | switch | cooldown M]", "error");
			}
		},
	});
}
