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
			writeFileSync(join(agentDir, "9router.json"), JSON.stringify({ baseUrl: url }, null, 2) + "\n");
		}
		baseUrl = url;
		apiKey = key;
		registerProvider(url, key, live.models);
		return key;
	}

	const oauth = {
		name: "9Router",
		login,
	};

	function registerProvider(url: string, key: string | undefined, models: Required<NineRouterModel>[]): void {
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: url,
			api: "openai-completions",
			apiKey: key,
			authHeader: true,
			oauth,
			models: models.map((m) => {
				const caps = m.capabilities ?? {};
				const contextWindow = caps.contextWindow ?? m.context_length ?? 128_000;
				return {
					id: m.id,
					name: m.id,
					contextWindow,
					maxTokens: caps.maxOutput ?? m.max_completion_tokens ?? Math.min(16_384, contextWindow),
					reasoning: caps.reasoning ?? false,
					supportsTools: caps.tools ?? true,
					input: caps.vision ? ["text", "image"] : ["text"],
				};
			}),
		});
	}

	// Register auth before probing. OMP 18.1+ requires `apiKey` or `oauth`
	// whenever runtime registration includes models; zero models keeps /login
	// available even when the endpoint is down or no key exists yet.
	registerProvider(baseUrl, apiKey, []);

	const result = await probeModels(baseUrl, apiKey);
	if (result.ok && result.models.length > 0) {
		registerProvider(baseUrl, apiKey, result.models);
	}

	// /9router — health probe: reachability, auth, discovered model list.
	pi.registerCommand("9router", {
		description: "Show 9Router connectivity status and discovered models",
		handler: async (_args, ctx) => {
			const live = await probeModels(baseUrl, apiKey);

			if (!live.ok) {
				const detail = live.error ?? `HTTP ${live.status}`;
				const hint =
					live.status === 401 || live.status === 403
						? `Set NINEROUTER_API_KEY, or pin providers.9router.apiKey in ${join(agentDir, "models.yml")}.`
						: `Check that 9Router is serving at ${baseUrl}.`;
				ctx.ui.notify(`9router unreachable at ${baseUrl}: ${detail}. ${hint}`, "error");
				return;
			}

			const ids = live.models.map((m) => m.id);
			const preview = ids.slice(0, 10).join(", ");
			const suffix = ids.length > 10 ? `, … (+${ids.length - 10} more)` : "";
			ctx.ui.notify(
				`9router ok at ${baseUrl} — ${ids.length} model(s): ${preview}${suffix}. Select with /model 9router/<id>.`,
				"info",
			);
		},
	});
}
