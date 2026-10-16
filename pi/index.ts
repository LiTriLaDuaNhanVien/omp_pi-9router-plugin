import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_URL = "http://localhost:20128/v1";
const normalize = (url: string) => url.trim().replace(/\/+$/, "");
const validAlias = /^[a-z][a-z0-9-]{0,31}$/;
// Clamp advertised output: hosts request `contextWindow - input` completion tokens,
// and gateways that inflate output/context make upstreams reject with 400.
const MAX_OUTPUT_CEILING = 131072;
const id = (alias: string) => alias === "default" ? "9router" : `9router-${alias}`;
type State = { baseUrl?: string; profiles?: Record<string, { baseUrl: string }> };
type RouterModel = { id: string; capabilities?: { vision?: boolean; reasoning?: boolean; contextWindow?: number; maxOutput?: number }; context_length?: number; max_completion_tokens?: number };

export default async function (pi: ExtensionAPI) {
 const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
 const statePath = join(agentDir, "9router.json");
 const load = (): State => {
  try { const value = JSON.parse(readFileSync(statePath, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
 };
 const save = (state: State) => { mkdirSync(agentDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); };
 const profiles: Record<string, string> = {};
 const state = load();
 for (const [alias, entry] of Object.entries(state.profiles || {})) {
  if (alias !== "default" && validAlias.test(alias) && typeof entry?.baseUrl === "string" && /^https?:\/\//.test(entry.baseUrl)) profiles[alias] = normalize(entry.baseUrl);
 }
 let baseUrl = normalize(process.env.NINEROUTER_BASE_URL || state.baseUrl || DEFAULT_URL);
 const storedKey = (alias: string): string | undefined => {
  try {
   const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, { key?: string; access?: string }>;
   return auth[id(alias)]?.access || auth[id(alias)]?.key;
  } catch { return undefined; }
 };
 const keys: Record<string, string | undefined> = {};
 const keyFor = (alias: string) => alias === "default" ? process.env.NINEROUTER_API_KEY || keys[alias] || storedKey(alias) : keys[alias] || storedKey(alias);

 async function discover(url: string, key?: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${url}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`9Router /models: HTTP ${response.status}`);
  const data = await response.json() as { data?: RouterModel[]; error?: string };
  if (!Array.isArray(data.data)) throw new Error(data.error || "Unexpected /models response");
  return data.data.filter((m) => typeof m.id === "string").map((m) => {
   const contextWindow = m.capabilities?.contextWindow || m.context_length || 128000;
   return { id: m.id, name: m.id, reasoning: m.capabilities?.reasoning ?? false, input: m.capabilities?.vision ? ["text", "image"] : ["text"], contextWindow, maxTokens: Math.min(m.capabilities?.maxOutput || m.max_completion_tokens || Math.min(16384, contextWindow), MAX_OUTPUT_CEILING), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  });
 }
 type LoginCallbacks = { onAuth: (info: { url: string; instructions?: string }) => void; onPrompt: (info: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>; onProgress?: (message: string) => void; signal?: AbortSignal };
 const urls = () => ({ default: baseUrl, ...profiles });
 function register(alias: string, models: ProviderModelConfig[]) {
  const url = urls()[alias];
  const oauth = {
   name: alias === "default" ? "9Router" : `9Router (${alias})`,
   async login({ onAuth, onPrompt, onProgress, signal }: LoginCallbacks) {
    const currentUrl = urls()[alias];
    onAuth({ url: currentUrl.replace(/\/v1$/, ""), instructions: "Copy your API key from the 9Router dashboard." });
    let endpoint = currentUrl;
    if (alias === "default") {
     const input = (await onPrompt({ message: "9Router API endpoint (empty to keep current)", placeholder: currentUrl, allowEmpty: true })).trim();
     endpoint = normalize(input || url);
     if (input && process.env.NINEROUTER_BASE_URL && normalize(process.env.NINEROUTER_BASE_URL) !== endpoint) throw new Error("Unset NINEROUTER_BASE_URL before changing the endpoint.");
    }
    const key = (await onPrompt({ message: `9Router ${alias} API key`, placeholder: "sk-…" })).trim();
    if (!key) throw new Error("API key required");
    onProgress?.("Checking 9Router models…");
    const found = await discover(endpoint, key, signal);
    if (alias === "default" && endpoint !== baseUrl) { save({ ...load(), baseUrl: endpoint }); baseUrl = endpoint; }
    keys[alias] = key;
    register(alias, found);
    return { access: key, refresh: key, expires: Number.MAX_SAFE_INTEGER };
   },
   async refreshToken(credentials: { access: string; refresh: string; expires: number }) { return credentials; },
   getApiKey(credentials: { access: string }) { return credentials.access; },
  };
  pi.registerProvider(id(alias), { baseUrl: url, api: "openai-completions", authHeader: true, oauth, models, refreshModels: async (context) => discover(urls()[alias], keyFor(alias), context.signal) });
 }
 for (const alias of Object.keys(urls())) register(alias, []);
 await Promise.all(Object.entries(urls()).map(async ([alias, url]) => {
  try { register(alias, await discover(url, keyFor(alias))); } catch { /* Keep login available when offline. */ }
 }));
 pi.registerCommand("9router", {
  description: "Manage 9Router profiles and check connectivity",
  handler: async (_args, ctx) => {
   const action = await ctx.ui.select("9Router profiles", ["List", "Add", "Update endpoint", "Remove", "Check"]);
   if (!action) return;
   if (action === "List") { ctx.ui.notify(Object.entries(urls()).map(([a, u]) => `${a}: ${u} → ${id(a)}`).join("\n"), "info"); return; }
   if (action === "Add") {
    const alias = (await ctx.ui.input("Profile alias (lowercase letters, digits, hyphens)", "work"))?.trim();
    if (!alias) return;
    if (alias === "default" || !validAlias.test(alias) || profiles[alias]) { ctx.ui.notify("Invalid or existing alias", "error"); return; }
    const url = normalize((await ctx.ui.input("9Router API endpoint", DEFAULT_URL)) || "");
    if (!/^https?:\/\/[^/]+/.test(url)) { ctx.ui.notify("Invalid http(s) endpoint", "error"); return; }
    profiles[alias] = url;
    try { const state = load(); state.profiles = { ...state.profiles, [alias]: { baseUrl: url } }; save(state); }
    catch (error) { delete profiles[alias]; ctx.ui.notify(String(error), "error"); return; }
    register(alias, []);
    ctx.ui.notify(`Added ${id(alias)}. Run /login ${id(alias)} to save its key.`, "info"); return;
   }
   const alias = await ctx.ui.select("Profile", Object.keys(urls()));
   if (!alias) return;
   if (action === "Remove") {
    if (alias === "default") { ctx.ui.notify("The default profile cannot be removed", "error"); return; }
    if (!await ctx.ui.confirm("Remove profile", `Remove ${alias}? Its credential remains until /logout ${id(alias)}.`)) return;
    const state = load(); if (state.profiles) delete state.profiles[alias]; save(state);
    delete profiles[alias]; delete keys[alias]; pi.unregisterProvider(id(alias));
    ctx.ui.notify(`Removed ${alias}. Run /logout ${id(alias)} to clear its saved key.`, "info"); return;
   }
   if (action === "Update endpoint") {
    const url = normalize((await ctx.ui.input("New API endpoint", urls()[alias])) || "");
    if (!/^https?:\/\/[^/]+/.test(url)) { ctx.ui.notify("Invalid http(s) endpoint", "error"); return; }
    if (alias === "default" && process.env.NINEROUTER_BASE_URL && normalize(process.env.NINEROUTER_BASE_URL) !== url) { ctx.ui.notify("Unset NINEROUTER_BASE_URL first", "error"); return; }
    const state = load(); if (alias === "default") state.baseUrl = url; else state.profiles = { ...state.profiles, [alias]: { baseUrl: url } }; save(state);
    if (alias === "default") baseUrl = url; else profiles[alias] = url;
    try { register(alias, await discover(url, keyFor(alias))); ctx.ui.notify(`Updated ${id(alias)}`, "info"); }
    catch (error) { register(alias, []); ctx.ui.notify(`Updated ${id(alias)}; probe failed: ${error}`, "warning"); }
    return;
   }
   try { const models = await discover(urls()[alias], keyFor(alias)); ctx.ui.notify(`${id(alias)}: ${models.length} models at ${urls()[alias]}. Select /model ${id(alias)}/<id>`, "info"); }
   catch (error) { ctx.ui.notify(`${id(alias)}: ${error}`, "error"); }
  },
 });
}
