# tempclaw

Persistent agent sandbox runner for Docker.

- `tempclaw openclaw up`
- `tempclaw openclaw tui`
- `tempclaw openclaw exec -- <command...>`
- `tempclaw openclaw logs`
- `tempclaw openclaw restart`
- `tempclaw openclaw down`
- `tempclaw hermes up`
- `tempclaw hermes tui`
- `tempclaw hermes exec -- <command...>`
- `tempclaw hermes logs`
- `tempclaw hermes restart`
- `tempclaw hermes down`

OpenClaw lifecycle deep dive: [docs/persistent-sandbox-flow.md](./docs/persistent-sandbox-flow.md)

## Install

```bash
git clone https://github.com/ziyincody/tempclaw
cd tempclaw
npm install
npm run build
```

## Usage

```bash
# Recommended: start a persistent OpenClaw sandbox and attach the TUI
npm run tempclaw -- openclaw up
npm run tempclaw -- openclaw tui

# Or start a persistent Hermes sandbox and open the CLI inside it
npm run tempclaw -- hermes up
npm run tempclaw -- hermes tui

# Run commands inside the live sandbox
npm run tempclaw -- openclaw exec -- openclaw plugins list

# Inspect logs
npm run tempclaw -- openclaw logs
npm run tempclaw -- hermes logs

# Restart the managed runtime after config or plugin changes
npm run tempclaw -- openclaw restart
npm run tempclaw -- hermes restart

# Tear it down
npm run tempclaw -- openclaw down
npm run tempclaw -- hermes down
```

## OpenClaw

### Persistent Sandbox

```bash
# Start a persistent sandbox (defaults to ../openclaw Dockerfile)
npm run tempclaw -- openclaw up

# Override OpenClaw repo path or image tag
npm run tempclaw -- openclaw up --openclawPath ../openclaw --image openclaw:local

# Run a prebuilt image (no local OpenClaw repo required)
npm run tempclaw -- openclaw up --image alpine/openclaw --skipBuild

# Set default model + thinking + verbosity
npm run tempclaw -- openclaw up --model openai/gpt-5.2 --thinking medium --verbose full

# Use a specific OpenClaw config file
npm run tempclaw -- openclaw up --configPath /path/to/openclaw.json

# Mount a local plugin explicitly
npm run tempclaw -- openclaw up --pluginPath /path/to/openclaw-plugin

# Mount an arbitrary local repo into the container without auto-loading it
npm run tempclaw -- openclaw up --mountPath /path/to/local-repo:/staging/local-repo

# Override provider base URLs for local integration testing
npm run tempclaw -- openclaw up --configPath /path/to/openclaw.json --providerBaseUrl local=<PROVIDER_URL>

# Pass extra env vars into the container for plugin/provider test setups
npm run tempclaw -- openclaw up --env INFERENCE_PROVIDER_BASE_URL=<PROVIDER_URL>

# Reattach the TUI later
npm run tempclaw -- openclaw tui

# View or follow gateway logs
npm run tempclaw -- openclaw logs
npm run tempclaw -- openclaw logs --follow

# Restart the gateway in place
npm run tempclaw -- openclaw restart

# Execute commands against the live sandbox
npm run tempclaw -- openclaw exec -- openclaw plugins list
```

## Hermes

```bash
# Start a persistent Hermes sandbox (defaults to ../hermes-agent Dockerfile)
npm run tempclaw -- hermes up

# Override Hermes repo path or image tag
npm run tempclaw -- hermes up --hermesPath ../hermes-agent --image hermes-agent:local

# Run a prebuilt image
npm run tempclaw -- hermes up --image tempclaw-hermes-smoke --skipBuild

# Seed Hermes with a specific config.yaml at startup
npm run tempclaw -- hermes up --configPath /path/to/config.yaml

# Start and manage a Hermes gateway inside the sandbox
npm run tempclaw -- hermes up --startGateway

# Launch a fresh Hermes interactive CLI inside the running sandbox
npm run tempclaw -- hermes tui

# View agent logs or a specific component
npm run tempclaw -- hermes logs
npm run tempclaw -- hermes logs --component gateway
npm run tempclaw -- hermes logs --component errors

# Restart only works when tempclaw started a managed Hermes gateway
npm run tempclaw -- hermes restart

# Execute arbitrary commands in the sandbox
npm run tempclaw -- hermes exec -- /opt/hermes/.venv/bin/hermes logs
npm run tempclaw -- hermes down
```

## CLI Features

- Persistent sandbox lifecycle: `up`, `tui`, `exec`, `logs`, `restart`, `down`
- Framework-specific command families for OpenClaw and Hermes
- Per-sandbox temp state/workspace mounted into the container
- OpenClaw runtime config seeded from `assets/openclaw/openclaw.json`
- OpenClaw exec approvals pre-seeded to avoid prompts
- OpenClaw model + thinking level overrides
- OpenClaw optional config import and plugin mounts
- Hermes bootstrap under `/opt/data`
- Generic read-only staging mounts and container env overrides for local test setups

### Flags

Shared:

- `--image` Docker image tag
- `--skipBuild` Skip Docker build and run the image directly
- `--mountPath` Extra read-only mount(s) as `hostPath:containerPath[,hostPath:containerPath...]`
- `--env` Extra container env var(s) as `KEY=value[,KEY=value...]`

OpenClaw:

- `--openclawPath` Path to OpenClaw repo (default `../openclaw`)
- `--model` Default model in `provider/model` format
- `--thinking` Thinking level: `off|minimal|low|medium|high|xhigh`
- `--verbose` Verbose level: `off|on|full`
- `--token` Gateway token override
- `--configPath` Path to an OpenClaw config file (openclaw.json)
- `--pluginPath` Path to a local OpenClaw plugin repo to mount and load
- `--providerBaseUrl` Provider base URL override(s) as `provider=url[,provider=url...]`
- `logs --lines` Number of gateway log lines to show (default `200`)
- `logs --follow` Stream gateway logs

Hermes:

- `--hermesPath` Path to Hermes repo (default `../hermes-agent`)
- `--configPath` Path to a Hermes config file (`config.yaml`)
- `--startGateway` Start and manage a Hermes gateway in the sandbox
- `logs --component` Hermes log component: `agent|gateway|errors`
- `logs --lines` Number of log lines to show (default `200`)
- `logs --follow` Stream log output

## Local Test Configs

Keep machine-specific presets out of git. This repo ignores `assets/openclaw/*.local.json` and `assets/hermes/*.local.yaml`, so local provider and plugin test configs can live there without becoming framework defaults.

For example:

```bash
cp ./assets/openclaw/openclaw.json ./assets/openclaw/openclaw.local.json
npm run tempclaw -- openclaw up \
  --configPath ./assets/openclaw/openclaw.local.json \
  --pluginPath /path/to/openclaw-plugin \
  --providerBaseUrl local=<PROVIDER_URL> \
  --env INFERENCE_PROVIDER_BASE_URL=<PROVIDER_URL>
```

`<PROVIDER_URL>` should be the provider base URL your local setup expects, for example `http://host.docker.internal:8787/v1`.

For Hermes with a custom local provider, start the provider on the host and preseed Hermes with a local config:

```bash
cd /Users/codywang/src/llm_provider
npm install
npm run dev
```

```bash
cd /Users/codywang/src/agentest
cp ./assets/hermes/hermes.example.yaml ./assets/hermes/hermes.local.yaml
MODEL_API_KEY=... \
npm run tempclaw -- hermes up \
  --configPath ./assets/hermes/hermes.local.yaml
```

Then open Hermes in the running sandbox:

```bash
npm run tempclaw -- hermes tui
```

For a production-like local plugin install flow, mount a packaged tarball without auto-loading it:

```bash
cd /path/to/plugin-repo
npm run build
npm pack

cd /Users/codywang/src/agentest
npm run tempclaw -- openclaw up \
  --mountPath /path/to/plugin-repo/plugin-package-0.1.0.tgz:/staging/plugin-package-0.1.0.tgz \
  --env INFERENCE_PROVIDER_BASE_URL=<PROVIDER_URL>
```

Then use the live sandbox for install and restart:

```bash
npm run tempclaw -- openclaw exec -- openclaw plugins install /staging/plugin-package-0.1.0.tgz
npm run tempclaw -- openclaw restart
npm run tempclaw -- openclaw tui
```

This validates the real packaged-plugin install flow. Use `--pluginPath` instead when you want the plugin loaded immediately for runtime behavior testing.

## Notes

- Requires Docker running.
- OpenClaw default config template: `assets/openclaw/openclaw.json` (copied into sandbox state at startup).
- Hermes can be preseeded with `assets/hermes/*.yaml` via `tempclaw hermes up --configPath ...`.
- OpenClaw exec approvals are seeded automatically to avoid approval prompts.
- API keys must be set in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- Verbose mode defaults to `full` for step-by-step tool output.
- Only one persistent sandbox is tracked at a time.
