# Native Pi 9Router extension

This directory contains the **Pi** version (`pi/index.ts`). For **OMP** use
the root `index.ts` instead; see the [OMP installation guide](../README.md#install-for-omp-oh-my-pi).
Do not run `pi install .` from the repository root.

## Install (Pi)

Requirements: Pi (`pi` in `PATH`), and a running 9Router server for model
discovery. From a fresh checkout (requires Git):

```bash
git clone https://github.com/LiTriLaDuaNhanVien/omp-9router-plugin.git
cd omp-9router-plugin
pi install ./pi
pi list
```

If already cloned, run `pi install /absolute/path/to/omp-9router-plugin/pi`
from any directory. `pi install` needs the source path **on the same line**;
`pi install` by itself reports “Missing install source”. A local-path install
loads the checkout in place; for updates run `git pull --ff-only` in the clone
and restart Pi (or use `/reload`). To install for just one trusted project,
use `pi install -l ./pi` inside that project with the appropriate absolute
source path; Pi will ask you to trust project configuration.

### Install with curl (no Git needed)

Download the repository tarball straight from GitHub, extract it to a permanent
directory, and install the `pi/` package from there:

```bash
mkdir -p ~/.pi/omp-9router-plugin \
  && curl -fsSL https://github.com/LiTriLaDuaNhanVien/omp-9router-plugin/archive/refs/heads/main.tar.gz \
    | tar -xz --strip-components=1 -C ~/.pi/omp-9router-plugin \
  && pi install ~/.pi/omp-9router-plugin/pi
```

Extract to a **permanent** directory (not `/tmp`): a local-path install loads
that checkout in place, so the files must survive reboots. To update, re-run the
same `curl … | tar …` line and restart Pi (or `/reload`). To uninstall, run
`pi remove ~/.pi/omp-9router-plugin/pi` and delete the directory.

Do **not** install the bare repository URL or root (`pi install
git:github.com/LiTriLaDuaNhanVien/omp-9router-plugin` or `pi install .`): the
repository root is the OMP package, and Pi would load nothing from it. Always
install the extracted `pi` subdirectory as shown above.

Test once without installing (from the repository root):

```bash
pi --no-extensions -e ./pi/index.ts --list-models
```

`--no-extensions` here avoids a duplicate if another copy is already installed;
explicit `-e` still loads this file. If the endpoint is offline or lacks a key,
there may be no models yet; the extension can still offer login. Do not load
both an installed copy and `-e` together in normal use.

## First login and profiles

Restart Pi and run `/login 9router` (or choose 9Router from `/login`). Enter
the endpoint (default `http://localhost:20128/v1`) and API key, then select
`/model 9router/<model-id>`. Run `/9router` to list, add, update endpoints,
remove, or check profiles. For a second server add alias `work` with its `/v1`
URL, run `/login 9router-work` for its key, then select
`/model 9router-work/<model-id>`. `default` is reserved for the original
`9router` provider.

Endpoints are stored in `~/.pi/agent/9router.json`; keys stay in Pi's auth
store. Removing a profile **does not delete its saved credential**; clear it
through Pi's logout/credential management if desired. Changing an endpoint
keeps the old key until you log in again. `PI_CODING_AGENT_DIR` changes the
agent directory. `NINEROUTER_BASE_URL` and `NINEROUTER_API_KEY` affect only
the default profile.

Model discovery requires a working `/v1/models` endpoint. Login remains
available if discovery fails at startup; retry after login or refresh models.
Pricing is reported as zero because 9Router does not supply reliable prices.

## Token-limit 400 errors

Advertised output is clamped to 131072 tokens because gateways that inflate
the output budget make hosts request a `contextWindow − input` completion that
upstreams with a smaller real limit reject with 400 "exceeds the model's
maximum context length". If the advertised **context window** itself is wrong
(e.g. ~508k claimed for glm-5.3 while the upstream enforces 400k), fix it per
model in `~/.pi/agent/models.json`; unknown ids are ignored:

```json
{
  "modelOverrides": {
    "9router-black/glm-5.3": { "contextWindow": 400000 }
  }
}
```

Use the exact id shown by `/model 9router-black/`; a smaller value leaves
more headroom for large replies.
