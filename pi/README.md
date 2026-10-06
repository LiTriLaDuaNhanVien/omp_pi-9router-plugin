# Native Pi 9Router extension

This is the Pi version of the OMP provider in the repository root. Install with the source path on the **same command line** (run from the repository root):

```sh
pi install ./pi
```

From another directory, use `pi install /path/to/omp-plugin-9router/pi` instead. Running `pi install` without a source reports “Missing install source”; entering the path alone tries to execute a directory.

Or test without installing: `pi --extension ./pi/index.ts --list-models`.
Restart Pi and use `/login 9router` (or `/login` and select 9Router). Enter the 9Router endpoint (default `http://localhost:20128/v1`) and API key. Select a model with `/model 9router/<model-id>`. `/9router` checks connectivity. The endpoint is stored in `~/.pi/agent/9router.json`; credentials are stored by Pi in its auth store. `PI_CODING_AGENT_DIR` changes the agent directory; `NINEROUTER_BASE_URL` overrides the stored endpoint and `NINEROUTER_API_KEY` can supply an environment key.

Model discovery requires a running 9Router `/v1/models` endpoint. If unavailable at startup, login remains registered and model discovery can be retried after login or via Pi's model refresh. Pricing is reported as zero because 9Router does not supply reliable per-model prices.
