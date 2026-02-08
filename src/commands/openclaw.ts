import { defineCommand } from 'citty'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  writeExecApprovals,
  writeRuntimeConfigFromHost,
  writeRuntimeConfigFromTemplate,
} from '../openclaw/config.js'

const execFileAsync = promisify(execFile)

export default defineCommand({
  meta: { name: 'openclaw', description: 'Run OpenClaw TUI inside an ephemeral Docker container' },
  args: {
    openclawPath: { type: 'string', description: 'Path to the OpenClaw repo', default: '../openclaw' },
    image: { type: 'string', description: 'Docker image tag to build/run', default: 'openclaw:local' },
    skipBuild: { type: 'boolean', description: 'Skip Docker build and run the image directly' },
    token: { type: 'string', description: 'Gateway token to use (defaults to random)' },
    model: { type: 'string', description: 'Default model (provider/model) for the session' },
    thinking: { type: 'string', description: 'Thinking level (off|minimal|low|medium|high|xhigh)' },
    useHostConfig: { type: 'boolean', description: 'Copy host ~/.openclaw/openclaw.json into container state' },
  },
  async run({ args }) {
    try {
      const normalizedModel = normalizeModel(args.model)
      const normalizedThinking = normalizeThinking(args.thinking)
      const shouldBuild = !args.skipBuild
      const openclawPath = resolve(args.openclawPath)
      const dockerfilePath = resolve(openclawPath, 'Dockerfile')
      const templatePath = resolve(process.cwd(), 'assets', 'openclaw', 'openclaw.json')

      if (shouldBuild) {
        await ensureExists(openclawPath, `OpenClaw path not found: ${openclawPath}`)
        await ensureExists(dockerfilePath, `OpenClaw Dockerfile not found: ${dockerfilePath}`)
      }

      await ensureDockerAvailable()
      if (!args.useHostConfig) {
        await ensureExists(templatePath, `OpenClaw template config not found: ${templatePath}`)
      }

      const token = (args.token && args.token.trim().length > 0)
        ? args.token.trim()
        : (args.useHostConfig ? undefined : randomBytes(16).toString('hex'))

      if (shouldBuild) {
        await runDockerBuild({ image: args.image, dockerfilePath, contextDir: openclawPath })
      }

      const runtime = await createRuntimeDirs()
      if (args.useHostConfig) {
        await writeRuntimeConfigFromHost(runtime.configPath, {
          token,
          model: normalizedModel,
        })
      } else if (token) {
        await writeRuntimeConfigFromTemplate(runtime.configPath, templatePath, {
          token,
          model: normalizedModel,
        })
      } else {
        throw new Error('Missing gateway token (provide --token or disable --useHostConfig)')
      }
      await writeExecApprovals(runtime.execApprovalsPath)

      try {
        await runDockerTui({ image: args.image, token, runtime, thinking: normalizedThinking })
      } finally {
        await cleanupRuntimeDirs(runtime.root)
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  },
})

async function ensureExists(path: string, message: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(message)
  }
}

async function ensureDockerAvailable(): Promise<void> {
  try {
    await execFileAsync('docker', ['version'])
  } catch (error) {
    throw new Error(
      `Docker not available (is it installed and running?). ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function runDockerBuild(options: {
  image: string
  dockerfilePath: string
  contextDir: string
}): Promise<void> {
  const code = await spawnAndWait('docker', [
    'build',
    '-t',
    options.image,
    '-f',
    options.dockerfilePath,
    options.contextDir,
  ])
  if (code !== 0) {
    throw new Error(`docker build failed (exit ${code})`)
  }
}

async function runDockerTui(options: {
  image: string
  token?: string
  runtime: RuntimeDirs
  thinking?: string
}): Promise<void> {
  const envArgs: string[] = [
    '-e', 'HOME=/home/node',
    '-e', 'TERM=xterm-256color',
    '-e', 'OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json',
    '-e', 'OPENCLAW_STATE_DIR=/home/node/.openclaw',
    '-e', 'OPENCLAW_WORKSPACE_DIR=/workspace',
  ]

  if (options.token) {
    envArgs.push('-e', `OPENCLAW_GATEWAY_TOKEN=${options.token}`)
  }

  // Pass through model provider keys when present.
  if (process.env.OPENAI_API_KEY) {
    envArgs.push('-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`)
  }
  if (process.env.ANTHROPIC_API_KEY) {
    envArgs.push('-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`)
  }

  const gatewayTokenArg = options.token ? '--token "$OPENCLAW_GATEWAY_TOKEN"' : ''
  const tuiTokenArg = options.token ? '--token "$OPENCLAW_GATEWAY_TOKEN"' : ''
  const tuiThinkingArg = options.thinking ? `--thinking "${options.thinking}"` : ''

  const containerCommand = [
    'set -euo pipefail',
    `node dist/index.js gateway --allow-unconfigured --bind loopback --port 18789 ${gatewayTokenArg} & GW=$!`,
    "trap 'kill $GW 2>/dev/null || true' EXIT",
    'for i in $(seq 1 50); do',
    "  if node -e 'const net=require(\"net\"); const s=net.connect(18789, \"127.0.0.1\"); s.on(\"connect\",()=>{s.end(); process.exit(0)}); s.on(\"error\",()=>{process.exit(1)});'; then break; fi",
    '  sleep 0.1',
    'done',
    `node dist/index.js tui --url ws://127.0.0.1:18789 ${tuiTokenArg} ${tuiThinkingArg}`,
  ].join('\n')

  const code = await spawnAndWait('docker', [
    'run',
    '--rm',
    '-it',
    '-v', `${options.runtime.stateDir}:/home/node/.openclaw`,
    '-v', `${options.runtime.workspaceDir}:/workspace`,
    ...envArgs,
    options.image,
    'bash',
    '-lc',
    containerCommand,
  ])
  if (code !== 0) {
    throw new Error(`docker run failed (exit ${code})`)
  }
}

function spawnAndWait(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

type RuntimeDirs = {
  root: string
  stateDir: string
  workspaceDir: string
  configPath: string
  execApprovalsPath: string
}

async function createRuntimeDirs(): Promise<RuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), 'skilltest-openclaw-'))
  const stateDir = join(root, 'state')
  const workspaceDir = join(root, 'workspace')
  await mkdir(stateDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  return {
    root,
    stateDir,
    workspaceDir,
    configPath: join(stateDir, 'openclaw.json'),
    execApprovalsPath: join(stateDir, 'exec-approvals.json'),
  }
}


function normalizeModel(model?: string): string | undefined {
  if (!model) return undefined
  const trimmed = model.trim()
  if (!trimmed) return undefined
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error('Invalid model format. Use provider/model (e.g., openai/gpt-5.2).')
  }
  return trimmed
}

function normalizeThinking(thinking?: string): string | undefined {
  if (!thinking) return undefined
  const trimmed = thinking.trim().toLowerCase()
  if (!trimmed) return undefined
  const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
  if (!allowed.includes(trimmed)) {
    throw new Error(`Invalid thinking level "${thinking}". Use one of: ${allowed.join(', ')}.`)
  }
  return trimmed
}



async function cleanupRuntimeDirs(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
