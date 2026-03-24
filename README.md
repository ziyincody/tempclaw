# tempclaw

Persistent OpenClaw sandbox runner for Docker.

tempclaw can still run the old one-shot TUI flow, but the recommended path is now a persistent sandbox lifecycle that is closer to a real OpenClaw install:

- `tempclaw openclaw up`
- `tempclaw openclaw tui`
- `tempclaw openclaw exec -- <command...>`
- `tempclaw openclaw down`

## Install

```bash
git clone https://github.com/ziyincody/tempclaw
cd tempclaw
npm install
npm run build
```

## Usage

```bash
# Recommended: start a persistent sandbox and attach the TUI
npm run tempclaw -- openclaw up
npm run tempclaw -- openclaw tui

# Run commands inside the live sandbox
npm run tempclaw -- openclaw exec -- openclaw plugins list

# Tear it down
npm run tempclaw -- openclaw down

# Legacy one-shot mode still works
npm run tempclaw -- openclaw
```

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
npm run tempclaw -- openclaw up --configPath /path/to/openclaw.json --providerBaseUrl local=http://host.docker.internal:8787/v1

# Pass extra env vars into the container for plugin/provider test setups
npm run tempclaw -- openclaw up --env INFERENCE_PROVIDER_BASE_URL=http://host.docker.internal:8787

# Reattach the TUI later
npm run tempclaw -- openclaw tui

# Execute install/restart commands against the live sandbox
npm run tempclaw -- openclaw exec -- openclaw plugins list
npm run tempclaw -- openclaw exec -- openclaw gateway restart
```

### Legacy One-Shot Mode

```bash
npm run tempclaw -- openclaw
```

## CLI Features

- Persistent sandbox lifecycle: `up`, `tui`, `exec`, `down`
- Legacy one-shot `openclaw` mode for quick smoke runs
- Per-sandbox temp state/workspace mounted into the container
- Runtime config seeded from `assets/openclaw/openclaw.json`
- Exec approvals pre-seeded to avoid prompts
- Model + thinking level overrides
- Optional config file import
- Explicit local plugin mounts for runtime testing
- Generic read-only staging mounts for install-flow testing
- Generic provider base URL and container env overrides for local test setups

### Flags

- `--openclawPath` Path to OpenClaw repo (default `../openclaw`)
- `--image` Docker image tag (default `openclaw:local`)
- `--skipBuild` Skip Docker build and run the image directly
- `--model` Default model in `provider/model` format
- `--thinking` Thinking level: `off|minimal|low|medium|high|xhigh`
- `--verbose` Verbose level: `off|on|full`
- `--token` Gateway token override
- `--configPath` Path to an OpenClaw config file (openclaw.json)
- `--pluginPath` Path to a local OpenClaw plugin repo to mount and load
- `--mountPath` Extra read-only mount(s) as `hostPath:containerPath[,hostPath:containerPath...]`
- `--providerBaseUrl` Provider base URL override(s) as `provider=url[,provider=url...]`
- `--env` Extra container env var(s) as `KEY=value[,KEY=value...]`

## Local Test Configs

Keep machine-specific presets out of git. This repo ignores `assets/openclaw/*.local.json`, so local provider and plugin test configs can live there without becoming framework defaults.

For example:

```bash
cp ./assets/openclaw/openclaw.json ./assets/openclaw/openclaw.local.json
npm run tempclaw -- openclaw up \
  --configPath ./assets/openclaw/openclaw.local.json \
  --pluginPath /path/to/openclaw-plugin \
  --providerBaseUrl local=http://host.docker.internal:8787/v1 \
  --env INFERENCE_PROVIDER_BASE_URL=http://host.docker.internal:8787
```

For a production-like local plugin install flow, mount a packaged tarball without auto-loading it:

```bash
cd /path/to/plugin-repo
npm run build
npm pack

cd /Users/codywang/src/agentest
npm run tempclaw -- openclaw up \
  --mountPath /path/to/plugin-repo/plugin-package-0.1.0.tgz:/staging/plugin-package-0.1.0.tgz \
  --env INFERENCE_PROVIDER_BASE_URL=http://host.docker.internal:8787
```

Then use the live sandbox for install and restart:

```bash
npm run tempclaw -- openclaw exec -- openclaw plugins install /staging/plugin-package-0.1.0.tgz
npm run tempclaw -- openclaw exec -- openclaw gateway restart
npm run tempclaw -- openclaw tui
```

This validates the real packaged-plugin install flow. Use `--pluginPath` instead when you want the plugin loaded immediately for runtime behavior testing.

## Notes

- Requires Docker running.
- Default config template: `assets/openclaw/openclaw.json` (copied into sandbox state at startup).
- Exec approvals are seeded automatically to avoid approval prompts.
- API keys must be set in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- Verbose mode defaults to `full` for step-by-step tool output.
- Only one persistent sandbox is tracked at a time.
