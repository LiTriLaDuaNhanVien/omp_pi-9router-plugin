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

## Install

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

### Troubleshooting `/login`

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

## Overrides

| Env var               | Default                         | Effect                          |
| --------------------- | ------------------------------- | ------------------------------- |
| `NINEROUTER_BASE_URL` | `http://localhost:20128/v1` | Point at another local or hosted 9Router instance |
| `NINEROUTER_API_KEY`  | unset                           | Dashboard bearer key            |

## Usage

```text
/9router                    # probe connectivity + list discovered models
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
- Verified end-to-end with a configured hosted 9Router endpoint: model
  discovery, text generation, and a `read` tool round-trip through
  `omp --print` all succeeded.