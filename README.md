# omp-plugin-9router

Registers [9Router](https://github.com/decolua/9router) as a model provider in
[oh-my-pi](https://github.com/can1357/oh-my-pi). The neutral default targets a
standard local 9Router install at `http://localhost:20128/v1`; `/login
9router` can configure any local or hosted endpoint.

9Router fronts 40+ providers behind one OpenAI-compatible gateway. The plugin
probes `/v1/models` at startup and materializes the catalog — extension
providers only receive explicit model lists from `pi.registerProvider`, so
context windows, vision, reasoning, and tool support are mapped from
9Router's per-model capabilities.

## Install for OMP (oh-my-pi)

The OMP extension is **`index.ts` at the repository root**. Install this
version if you run `omp`; do not install the `pi/` subdirectory into OMP.

### Linux/macOS

Install without Bun (requires Git):

```bash
agent="$(omp config path)" && dir="$agent/extensions/9router" && mkdir -p "$agent/extensions" && if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only origin main; else git clone --depth 1 --branch main https://github.com/LiTriLaDuaNhanVien/omp-9router-plugin.git "$dir"; fi
```

### Windows (PowerShell)

Download and review the installer before running it:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/LiTriLaDuaNhanVien/omp-9router-plugin/main/scripts/install.ps1 -OutFile install-9router.ps1
& ./install-9router.ps1
```
The script calls `omp config path`, so it installs into the active profile or
agent directory, and clones or fast-forwards an existing checkout. It needs
`omp` and Git in `PATH`; it does **not** need Bun.

Fully exit and restart `omp`, then run `/login 9router`. Select a discovered
model with `/model 9router/<model-id>`.

If `bun` is installed, omp's plugin manager is also supported:

```bash
omp plugin install github:LiTriLaDuaNhanVien/omp-9router-plugin#main
```

`omp plugin install` invokes the external `bun` executable; omp's bundled
runtime does not provide that command in `$PATH`.

### Manual/development install

The plugin is a plain oh-my-pi extension package (`omp.extensions` manifest in
`package.json`). For local development, load it by either:

- adding the directory to the user config:

  ```yaml
  # ~/.omp/agent/config.yml
  extensions:
    - /path/to/omp-9router-plugin
  ```

- copying or symlinking it into `$(omp config path)/extensions/9router/`;
- project-local: drop it under `<repo>/.omp/extensions/`.

Restart `omp` (or `/reload`) after changing the local extension path.

## Install for Pi (native Pi, not OMP)

Pi uses **`pi/index.ts`**, not the root OMP extension. Clone the repository
once and install its `pi/` package by path:

```bash
git clone https://github.com/LiTriLaDuaNhanVien/omp-9router-plugin.git
cd omp-9router-plugin
pi install ./pi
```

If you already cloned the repository, run `pi install /absolute/path/to/omp-9router-plugin/pi`
instead. For later updates, run `git pull --ff-only` inside your clone and
restart Pi (or use `/reload`); a local-path Pi install loads that checkout,
not a copied snapshot. For a one-off test without installation, from the
repository root run `pi --no-extensions -e ./pi/index.ts --list-models`.
See [Pi-specific instructions](pi/README.md) for verification and profiles —
including a curl one-liner that installs `pi/` from the GitHub tarball without
Git.
Do not run `pi install .`: the repository root contains the OMP package.

### Troubleshooting OMP `/login`

Confirm the clone landed in the active agent directory:

```bash
test -f "$(omp config path)/extensions/9router/index.ts" && echo "9Router plugin found"
```

If `/login` still omits 9Router after a full restart, force-load the extension
once to surface any load error:

```bash
omp -e "$(omp config path)/extensions/9router" --print "reply ok"
```

Do not pass `--no-extensions`; it disables ambient extension discovery.

## Credentials

The dashboard API key must reach the provider once. Three options, in the order most users should pick:

1. `/login 9router` inside a session (native — the plugin registers a runtime
   OAuth-provider definition, so 9Router appears in the `/login` list like a
   built-in). It shows the dashboard URL, prompts for the endpoint (**empty
   keeps the current**), then the key, validates the key against that endpoint,
   and stores it as a login-sourced credential. A custom endpoint is persisted
   to `$(omp config path)/9router.json` and survives restarts; `/logout` clears
   the key.

2. Pin it in `$(omp config path)/models.yml` (keeps the secret out of the repo
   and shell history):

   ```yaml
   providers:
     9router:
       apiKey: sk-...
   ```

   A `models.yml` `apiKey` sits near the top of the credential-resolution
   order, so it wins once the extension registers the `9router` provider id.

3. Export `NINEROUTER_API_KEY=sk-...` in the shell or a supported `.env` file.

Endpoint precedence: `NINEROUTER_BASE_URL` env > `$(omp config
path)/9router.json` (written by `/login`) > the built-in default. An exported
`NINEROUTER_BASE_URL` shadows the state file, so `/login` refuses to persist a
divergent URL until you unset it. The state file holds only the URL — **the key
never leaves omp's auth store**.

When `/login` succeeds after startup discovery failed, the plugin registers
the freshly discovered models immediately — no `/reload` needed.

### Multiple servers

Run `/9router` to list, add, update endpoints, remove, or check profiles. The
existing `9router` provider is the reserved `default` profile. For example,
add alias `work` with its server's `/v1` URL, then run `/login 9router-work`
to store its API key with the host's credential storage. Select its models via
`/model 9router-work/<model-id>`. Each profile has an independent model list
and key. Profiles are stored as endpoints only in `9router.json`; existing
`baseUrl` entries remain the default profile. The default key and URL env vars
apply only to `9router`, not to aliases. You can also use per-provider keys in
`models.yml` under `providers.9router-work.apiKey` (OMP).

Removing a profile unregisters it immediately but **does not erase its saved
key**. Use `/logout 9router-work` to clear that credential if supported by your
host, or remove it through the host's credential manager. If you re-add the
same alias, the saved credential can be reused. Changing a profile's endpoint
retains its key, so log in again if the new server needs a different key.

## Overrides

| Env var               | Default                         | Effect                          |
| --------------------- | ------------------------------- | ------------------------------- |
| `NINEROUTER_BASE_URL` | `http://localhost:20128/v1` | Point at another local or hosted 9Router instance |
| `NINEROUTER_API_KEY`  | unset                           | Dashboard bearer key            |

## Usage

```text
/9router                    # manage profiles or check connectivity
/model 9router/default      # pick a routed model (autocomplete lists all 97)
```

or headless:

```bash
omp --print --model 9router/kr/gpt-5.6-luna "hello"
```

Standard provider controls keep working: `disabledProviders: [9router]` hides
it; `modelOverrides` in `models.yml` can adjust context windows or costs for
individual ids.

## Notes

- `api` is `openai-completions`; the gateway normalizes Claude-family ids onto
  that wire itself.
- Combo routes may return transient 503 errors while their upstream quota
  resets. That is gateway-side. The plugin treats failed discovery as a model
  probe failure: native `/login` remains registered, while unavailable model
  rows are withheld until a successful login or restart.
- Advertised output limits are clamped to 131072 tokens: some gateways report
  an output budget close to the context window, hosts then request a
  completion of `contextWindow − input` tokens, and upstreams with a smaller
  real limit reject the request with 400 "exceeds the model's maximum context
  length". If a model still fails because the advertised **context window**
  itself is larger than the upstream's real limit (e.g. a gateway claims
  ~508k for glm-5.3 while the upstream enforces 400k), correct it for that
  model id in `$(omp config path)/models.yml` — including profiles:

  ```yaml
  modelOverrides:
    "9router-black/glm-5.3":
      contextWindow: 400000
  ```

  Find the exact id with `/model 9router-black/`. A smaller value (e.g.
  380000) leaves more headroom for large replies.
- Verified end-to-end with a configured hosted 9Router endpoint: model
  discovery, text generation, and a `read` tool round-trip through
  `omp --print` all succeeded.