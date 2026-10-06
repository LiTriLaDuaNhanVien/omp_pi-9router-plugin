import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_URL = "http://localhost:20128/v1";
const normalize = (url: string) => url.trim().replace(/\/+$/, "");

type RouterModel = {
 id: string;
 capabilities?: { vision?: boolean; reasoning?: boolean; contextWindow?: number; maxOutput?: number };
 context_length?: number;
 max_completion_tokens?: number;
};

export default async function (pi: ExtensionAPI) {
 const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
 const statePath = join(agentDir, "9router.json");
 const storedKey = (): string | undefined => {
  try {
   const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, { key?: string; access?: string }>;
   return auth["9router"]?.access || auth["9router"]?.key;
  } catch { return undefined; }
 };
 let savedUrl: string | undefined;
 try { savedUrl = (JSON.parse(readFileSync(statePath, "utf8")) as { baseUrl?: string }).baseUrl; } catch { /* first run */ }
 let baseUrl = normalize(process.env.NINEROUTER_BASE_URL || savedUrl || DEFAULT_URL);

 async function discover(key?: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${baseUrl}/models`, {
   headers: key ? { Authorization: `Bearer ${key}` } : {},
   signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`9Router /models: HTTP ${response.status}`);
  const data = (await response.json()) as { data?: RouterModel[]; error?: string };
  if (!Array.isArray(data.data)) throw new Error(data.error || "Unexpected /models response");
  return data.data.filter((m) => typeof m.id === "string").map((m) => {
   const contextWindow = m.capabilities?.contextWindow || m.context_length || 128000;
   return {
    id: m.id, name: m.id, reasoning: m.capabilities?.reasoning ?? false,
    input: m.capabilities?.vision ? ["text", "image"] : ["text"],
    contextWindow, maxTokens: m.capabilities?.maxOutput || m.max_completion_tokens || Math.min(16384, contextWindow),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   };
  });
 }

 const oauth = {
  name: "9Router",
  async login({ onAuth, onPrompt, onProgress, signal }: {
   onAuth: (info: { url: string; instructions?: string }) => void;
   onPrompt: (info: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
   onProgress?: (message: string) => void;
   signal?: AbortSignal;
  }) {
   onAuth({ url: baseUrl.replace(/\/v1$/, ""), instructions: "Copy your API key from the 9Router dashboard." });
   const input = (await onPrompt({ message: "9Router API endpoint (empty to keep current)", placeholder: baseUrl, allowEmpty: true })).trim();
   const url = normalize(input || baseUrl);
   if (input && process.env.NINEROUTER_BASE_URL && normalize(process.env.NINEROUTER_BASE_URL) !== url)
    throw new Error("Unset NINEROUTER_BASE_URL before changing the endpoint.");
   const key = (await onPrompt({ message: "9Router API key", placeholder: "sk-…" })).trim();
   if (!key) throw new Error("API key required");
   onProgress?.("Checking 9Router models…");
   const previous = baseUrl;
   baseUrl = url;
   try {
    const models = await discover(key, signal);
    if (input) {
     mkdirSync(agentDir, { recursive: true });
     writeFileSync(statePath, JSON.stringify({ baseUrl: url }, null, 2) + "\n", { mode: 0o600 });
    }
    pi.registerProvider("9router", { baseUrl, api: "openai-completions", authHeader: true, oauth, models, refreshModels: async (context) => discover(process.env.NINEROUTER_API_KEY || storedKey(), context.signal) });
    return { access: key, refresh: key, expires: Number.MAX_SAFE_INTEGER };
   } catch (error) { baseUrl = previous; throw error; }
  },
  async refreshToken(credentials: { access: string; refresh: string; expires: number }) { return credentials; },
  getApiKey(credentials: { access: string }) { return credentials.access; },
 };

 let initialModels: ProviderModelConfig[] = [];
 try { initialModels = await discover(process.env.NINEROUTER_API_KEY || storedKey()); } catch { /* login remains available offline */ }
 pi.registerProvider("9router", {
  baseUrl, api: "openai-completions", authHeader: true, oauth, models: initialModels,
  async refreshModels(context) {
   const key = process.env.NINEROUTER_API_KEY || storedKey();
   return discover(key, context.signal);
  },
 });

 pi.registerCommand("9router", {
  description: "Check 9Router and list available models",
  handler: async (_args, ctx) => {
   try {
    const key = process.env.NINEROUTER_API_KEY || storedKey();
    const models = await discover(key);
    ctx.ui.notify(`9Router: ${models.length} models at ${baseUrl}. ${models.slice(0, 8).map((m) => m.id).join(", ")}`, "info");
   } catch (error) { ctx.ui.notify(String(error), "error"); }
  },
 });
}
