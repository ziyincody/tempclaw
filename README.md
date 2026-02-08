# tempclaw

Instant OpenClaw sandbox runner.

tempclaw spins up an ephemeral OpenClaw TUI inside Docker with a pre-seeded config and approvals, so you can debug skills and workflows without onboarding or polluting your local state.

## Install

```bash
git clone https://github.com/ziyincody/tempclaw
cd tempclaw
npm install
npm run build
```

## Usage

```bash
# Build + run OpenClaw TUI (defaults to ../openclaw Dockerfile)
npm run tempclaw openclaw

# Override OpenClaw repo path or image tag
npm run tempclaw openclaw --openclawPath ../openclaw --image openclaw:local

# Run a prebuilt image (no local OpenClaw repo required)
npm run tempclaw openclaw --image alpine/openclaw --skipBuild

# Set default model + thinking + verbosity
npm run tempclaw openclaw --model openai/gpt-5.2 --thinking medium --verbose full


# Use a specific OpenClaw config file
npm run tempclaw openclaw --configPath /path/to/openclaw.json
```

## CLI Features

- `openclaw` subcommand to build and run OpenClaw TUI in Docker
- Per-run ephemeral state/workspace mounted into the container
- Runtime config seeded from `assets/openclaw/openclaw.json`
- Exec approvals pre-seeded to avoid prompts
- Model + thinking level overrides
- Optional config file import

### Flags

- `--openclawPath` Path to OpenClaw repo (default `../openclaw`)
- `--image` Docker image tag (default `openclaw:local`)
- `--skipBuild` Skip Docker build and run the image directly
- `--model` Default model in `provider/model` format
- `--thinking` Thinking level: `off|minimal|low|medium|high|xhigh`
- `--verbose` Verbose level: `off|on|full`
- `--token` Gateway token override
- `--configPath` Path to an OpenClaw config file (openclaw.json)

## Notes

- Requires Docker running.
- Default config template: `assets/openclaw/openclaw.json` (copied into container state at startup).
- Exec approvals are seeded automatically to avoid approval prompts.
- API keys must be set in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- Verbose mode defaults to `full` for step-by-step tool output.
