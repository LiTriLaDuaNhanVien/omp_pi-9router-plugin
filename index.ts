import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 * Registers 9Router (https://github.com/decolua/9router) as a model provider
 * in oh-my-pi. The neutral default targets a standard local 9Router install:
 *
 *   Dashboard:    http://localhost:20128/
 *   OpenAI API:   http://localhost:20128/v1
 *   Models list:  GET /v1/models
 *
 * Configuration:
 *   NINEROUTER_BASE_URL  — override the endpoint (default http://localhost:20128/v1)
 *   NINEROUTER_API_KEY   — dashboard API key. When unset, the key pinned in
 *                          the active agent directory's models.yml wins through
 *                          the normal credential-resolution order.
 * Extension providers receive only an explicit model list from
 * pi.registerProvider (no runtime discovery hook), so this factory probes
 * /v1/models and maps 9router's per-model capabilities into catalog metadata.
 * A failed probe withholds model rows but keeps native /login registered.
 *
 * /login uses provider-owned runtime OAuth registration (the same dispatch
 * path as built-ins); a returned string is stored as a login-sourced API-key
 * credential.
 */

const PROVIDER_ID = "9router";
const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const PROBE_TIMEOUT_MS = 8_000;
/*
 * Gateways sometimes advertise an output budget nearly as large as the assumed
 * context window; hosts then request `contextWindow - input` completion tokens
 * and upstreams with a smaller real limit reject the whole request with 400
 * "exceeds the model's maximum context length". Clamp the advertised output so
 * the completion request stays small; correct a wrong contextWindow with a
 * modelOverrides entry in models.yml (see README).
 */
const MAX_OUTPUT_CEILING = 131_072;
const aliasPattern = /^[a-z][a-z0-9-]{0,31}$/;
const providerId = (alias: string) => alias === "default" ? PROVIDER_ID : `${PROVIDER_ID}-${alias}`;
const normalize = (url: string) => url.trim().replace(/\/+$/, "");

type ProfileState = { baseUrl?: string; profiles?: Record<string, { baseUrl: string }> };
function loadState(agentDir: string): ProfileState {
	try {
		const state = JSON.parse(readFileSync(join(agentDir, "9router.json"), "utf-8")) as ProfileState;
		if (state && typeof state === "object" && !Array.isArray(state)) return state;
	} catch { /* First run. */ }
	return {};
}
function saveState(agentDir: string, state: ProfileState): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "9router.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
function profilesFrom(state: ProfileState): Record<string, string> {
	const profiles: Record<string, string> = {};
	for (const [alias, entry] of Object.entries(state.profiles ?? {})) {
		if (alias !== "default" && aliasPattern.test(alias) && typeof entry?.baseUrl === "string" && /^https?:\/\//.test(entry.baseUrl)) profiles[alias] = normalize(entry.baseUrl);
	}
	return profiles;
}

/**
 * Endpoint, in precedence order: NINEROUTER_BASE_URL env > state file written
 * by /login > built-in default. The state file lets a custom endpoint survive
 * restarts without touching models.yml or shell config; credentials stay in
 * omp's own auth store.
 */
function loadBaseUrl(agentDir: string): string {
	let url = DEFAULT_BASE_URL;
	if (process.env.NINEROUTER_BASE_URL) {
		url = process.env.NINEROUTER_BASE_URL;
	} else {
		try {
			url = (JSON.parse(readFileSync(join(agentDir, "9router.json"), "utf-8")) as { baseUrl?: string }).baseUrl ?? url;
		} catch {
			// No state file yet.
		}
	}
	return url.replace(/\/+$/, "");
}
/**
 * Dashboard key, mirroring omp's credential order for our needs:
 * NINEROUTER_API_KEY first, then the models.yml pin
 * (providers.9router.apiKey, env-name-or-literal semantics). The pin exists
 * precisely so the secret stays out of this repo, and this plugin's probe
 * needs the same credential omp will dispatch with.
 */
function resolveApiKey(agentDir: string): string | undefined {
	const envKey = process.env.NINEROUTER_API_KEY;
	if (envKey) return envKey;
	for (const name of ["models.yml", "models.yaml"]) {
		let text: string;
		try {
			text = readFileSync(join(agentDir, name), "utf-8");
		} catch {
			continue;
		}
		// providers: \n  9router: \n    apiKey: <value>
		const block = text.match(/(^|\n)providers:\s*\n((?:[ \t]+\S.*\n?)*)/);
		const provider = block?.[2].match(/^[ \t]+9router:\s*\n((?:[ \t]+\S.*\n?)*)/m);
		const apiKey = provider?.[1].match(/^[ \t]+apiKey:\s*(\S+)\s*$/m);
		const value = apiKey?.[1]?.replace(/^["']|["']$/g, "");
		if (value) return process.env[value] ?? value;
	}
	return undefined;
}

interface NineRouterCapabilities {
	vision?: boolean;
	tools?: boolean;
	reasoning?: boolean;
	contextWindow?: number;
	maxOutput?: number;
}

interface NineRouterModel {
	id?: string;
	owned_by?: string;
	capabilities?: NineRouterCapabilities;
	context_length?: number;
	max_completion_tokens?: number;
}

type ProbeResult =
	| { ok: true; models: Required<NineRouterModel>[] }
	| { ok: false; status?: number; error?: string };

async function probeModels(baseUrl: string, apiKey: string | undefined, signal?: AbortSignal): Promise<ProbeResult> {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			return { ok: false, status: response.status };
		}
		const payload = (await response.json()) as { data?: NineRouterModel[]; error?: string };
		if (!Array.isArray(payload.data)) {
			// 9router answers 200 with {"error": "..."} for bad/missing keys.
			return { ok: false, error: payload.error ?? "unexpected /models payload" };
		}
		const models = payload.data.filter((m): m is Required<NineRouterModel> => typeof m.id === "string");
		return { ok: true, models };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export default async function nineRouterProvider(pi: ExtensionAPI) {
	pi.setLabel("9Router provider");

	const agentDir = pi.pi.getAgentDir();
	// Mutable: /login may switch endpoint and credential mid-session.
	let baseUrl = loadBaseUrl(agentDir);
	let apiKey = resolveApiKey(agentDir);
	const profiles = profilesFrom(loadState(agentDir));
	const keys: Record<string, string | undefined> = {};

	async function login({ onAuth, onPrompt, onProgress, signal }: {
		onAuth?: (details: { url: string; instructions: string }) => void;
		onPrompt?: (details: { message: string; placeholder: string; allowEmpty?: boolean }) => Promise<string>;
		onProgress?: (message: string) => void;
		signal?: AbortSignal;
	}): Promise<string> {
		onAuth?.({
			url: baseUrl.replace(/\/v1$/, ""),
			instructions: "Open the 9Router dashboard and copy an API key",
		});
		if (!onPrompt) {
			throw new Error("9Router login needs an interactive prompt; set NINEROUTER_API_KEY instead.");
		}
		const urlInput = (
			await onPrompt({
				message: "9Router endpoint URL (empty to keep current)",
				placeholder: baseUrl,
				allowEmpty: true,
			})
		).trim();
		const url = (urlInput || baseUrl).replace(/\/+$/, "");
		const key = (await onPrompt({ message: "Paste your 9Router API key", placeholder: "sk-…" })).trim();
		if (!key) {
			throw new Error("9Router API key is required.");
		}
		onProgress?.(`Validating API key against ${url}…`);
		const live = await probeModels(url, key, signal);
		if (!live.ok) {
			throw new Error(`${url} rejected the key: ${live.error ?? `HTTP ${live.status}`}`);
		}
		if (urlInput) {
			if (process.env.NINEROUTER_BASE_URL && process.env.NINEROUTER_BASE_URL !== url) {
				throw new Error("NINEROUTER_BASE_URL is exported in your shell; unset it or set it to this URL.");
			}
			mkdirSync(agentDir, { recursive: true });
			saveState(agentDir, { ...loadState(agentDir), baseUrl: url });
		}
		baseUrl = url;
		apiKey = key;
		registerProvider("default", url, key, live.models);
		return key;
	}

	const oauth = {
		name: "9Router",
		login,
	};

	function registerProvider(alias: string, url: string, key: string | undefined, models: Required<NineRouterModel>[]): void {
		pi.registerProvider(providerId(alias), {
			baseUrl: url,
			api: "openai-completions",
			apiKey: key,
			authHeader: true,
			oauth: alias === "default" ? oauth : {
				name: `9Router (${alias})`,
				async login({ onPrompt, onProgress, signal }: Parameters<typeof login>[0]) {
					if (!onPrompt) throw new Error("Interactive login required");
					const value = (await onPrompt({ message: `API key for ${alias} (${profiles[alias]})`, placeholder: "sk-…" })).trim();
					if (!value) throw new Error("API key required");
					onProgress?.(`Checking ${alias}…`);
					const live = await probeModels(profiles[alias], value, signal);
					if (!live.ok) throw new Error(`${alias}: ${live.error ?? `HTTP ${live.status}`}`);
					keys[alias] = value;
					registerProvider(alias, profiles[alias], value, live.models);
					return value;
				},
			},
			fetchDynamicModels: async (resolvedKey) => {
				const live = await probeModels(alias === "default" ? baseUrl : profiles[alias], resolvedKey);
				if (!live.ok) throw new Error(`${providerId(alias)}: ${live.error ?? `HTTP ${live.status}`}`);
				return mapModels(live.models);
			},
			models: mapModels(models),
		});
	}

	function mapModels(models: Required<NineRouterModel>[]) {
		return models.map((m) => {
			const caps = m.capabilities ?? {};
			const contextWindow = caps.contextWindow ?? m.context_length ?? 128_000;
			return {
				id: m.id,
				name: m.id,
				contextWindow,
				maxTokens: Math.min(caps.maxOutput ?? m.max_completion_tokens ?? Math.min(16_384, contextWindow), MAX_OUTPUT_CEILING),
				reasoning: caps.reasoning ?? false,
				supportsTools: caps.tools ?? true,
				input: caps.vision ? ["text", "image"] : ["text"],
			};
		});
	}

	// Register auth before probing. OMP 18.1+ requires `apiKey` or `oauth`
	// whenever runtime registration includes models; zero models keeps /login
	// available even when the endpoint is down or no key exists yet.
	registerProvider("default", baseUrl, apiKey, []);
	for (const [alias, url] of Object.entries(profiles)) registerProvider(alias, url, undefined, []);

	const result = await probeModels(baseUrl, apiKey);
	if (result.ok && result.models.length > 0) registerProvider("default", baseUrl, apiKey, result.models);

	pi.registerCommand("9router", {
		description: "Manage 9Router profiles and check connectivity",
		handler: async (_args, ctx) => {
			const action = await ctx.ui.select("9Router profiles", ["List", "Add", "Update endpoint", "Remove", "Check"]);
			if (!action) return;
			if (action === "List") {
				ctx.ui.notify([`default: ${baseUrl} → 9router`, ...Object.entries(profiles).map(([a, u]) => `${a}: ${u} → ${providerId(a)}`)].join("\n"), "info");
				return;
			}
			if (action === "Add") {
				const alias = (await ctx.ui.input("Profile alias (lowercase letters, digits, hyphens)", "work"))?.trim();
				if (!alias) return;
				if (alias === "default" || !aliasPattern.test(alias) || profiles[alias]) { ctx.ui.notify("Invalid or existing alias", "error"); return; }
				const url = normalize((await ctx.ui.input("9Router API endpoint", DEFAULT_BASE_URL)) ?? "");
				if (!/^https?:\/\/[^/]+/.test(url)) { ctx.ui.notify("Invalid http(s) endpoint", "error"); return; }
				profiles[alias] = url;
				try { const state = loadState(agentDir); state.profiles = { ...state.profiles, [alias]: { baseUrl: url } }; saveState(agentDir, state); }
				catch (error) { delete profiles[alias]; ctx.ui.notify(String(error), "error"); return; }
				registerProvider(alias, url, undefined, []);
				ctx.ui.notify(`Added ${providerId(alias)}. Run /login ${providerId(alias)} to save its key.`, "info");
				return;
			}
			const alias = await ctx.ui.select("Profile", ["default", ...Object.keys(profiles)]);
			if (!alias) return;
			if (action === "Remove") {
				if (alias === "default") { ctx.ui.notify("The default profile cannot be removed", "error"); return; }
				if (!await ctx.ui.confirm("Remove profile", `Remove ${alias}? Its saved credential remains until /logout ${providerId(alias)}.`)) return;
				const state = loadState(agentDir); if (state.profiles) delete state.profiles[alias];
				saveState(agentDir, state); delete profiles[alias]; delete keys[alias]; pi.unregisterProvider(providerId(alias));
				ctx.ui.notify(`Removed ${alias}. Run /logout ${providerId(alias)} to clear its saved key.`, "info");
				return;
			}
			if (action === "Update endpoint") {
				const current = alias === "default" ? baseUrl : profiles[alias];
				const url = normalize((await ctx.ui.input("New API endpoint", current)) ?? "");
				if (!/^https?:\/\/[^/]+/.test(url)) { ctx.ui.notify("Invalid http(s) endpoint", "error"); return; }
				if (alias === "default" && process.env.NINEROUTER_BASE_URL && normalize(process.env.NINEROUTER_BASE_URL) !== url) { ctx.ui.notify("Unset NINEROUTER_BASE_URL first", "error"); return; }
				const state = loadState(agentDir);
				if (alias === "default") state.baseUrl = url;
				else state.profiles = { ...state.profiles, [alias]: { baseUrl: url } };
				saveState(agentDir, state);
				if (alias === "default") baseUrl = url; else profiles[alias] = url;
				const key = alias === "default" ? apiKey : keys[alias] ?? await ctx.modelRegistry.getApiKeyForProvider(providerId(alias));
				const live = await probeModels(url, key);
				registerProvider(alias, url, key, live.ok ? live.models : []);
				ctx.ui.notify(`Updated ${providerId(alias)}. ${live.ok ? `${live.models.length} models` : "Probe failed; check credentials"}.`, live.ok ? "info" : "warning");
				return;
			}
			const url = alias === "default" ? baseUrl : profiles[alias];
			const live = await probeModels(url, alias === "default" ? apiKey : keys[alias] ?? await ctx.modelRegistry.getApiKeyForProvider(providerId(alias)));
			ctx.ui.notify(live.ok ? `${providerId(alias)}: ${live.models.length} models at ${url}. Select /model ${providerId(alias)}/<id>` : `${providerId(alias)} at ${url}: ${live.error ?? `HTTP ${live.status}`}`, live.ok ? "info" : "error");
		},
	});
}
