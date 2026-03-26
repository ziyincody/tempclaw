import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { MountPath, PluginMount, RuntimeDirs } from './openclaw-types.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_GATEWAY_PORT = 18789
export const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`
export const DEFAULT_GATEWAY_LOG_PATH = '/home/node/.openclaw/tempclaw-gateway.log'
const DEFAULT_KEEPALIVE_COMMAND = 'trap "exit 0" TERM INT; while true; do sleep 3600; done'
const DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_GATEWAY_STARTUP_POLL_MS = 500

export async function ensureDockerAvailable(): Promise<void> {
  try {
    await execFileAsync('docker', ['version'])
  } catch (error) {
    throw new Error(
      `Docker not available (is it installed and running?). ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function runDockerBuild(options: {
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

export async function createDetachedContainer(options: {
  image: string
  token?: string
  runtime: RuntimeDirs
  pluginMounts: PluginMount[]
  extraMounts: MountPath[]
  extraEnv: Record<string, string>
  containerName: string
}): Promise<void> {
  const envArgs = buildContainerEnvArgs(options.token, options.extraEnv)
  const pluginVolumeArgs = options.pluginMounts.flatMap((mount) => [
    '-v',
    `${mount.hostPath}:${mount.containerPath}:ro`,
  ])
  const extraVolumeArgs = options.extraMounts.flatMap((mount) => [
    '-v',
    `${mount.hostPath}:${mount.containerPath}:ro`,
  ])

  const { stdout } = await execFileAsync('docker', [
    'run',
    '-d',
    '--name',
    options.containerName,
    '-v', `${options.runtime.stateDir}:/home/node/.openclaw`,
    '-v', `${options.runtime.workspaceDir}:/workspace`,
    ...pluginVolumeArgs,
    ...extraVolumeArgs,
    ...envArgs,
    options.image,
    'bash',
    '-lc',
    DEFAULT_KEEPALIVE_COMMAND,
  ])

  if (!stdout.trim()) {
    throw new Error('docker run did not return a container id')
  }
}

export async function startGatewayInContainer(containerName: string): Promise<void> {
  const gatewayCommand = [
    'set -euo pipefail',
    `node dist/index.js gateway --allow-unconfigured --bind loopback --port ${DEFAULT_GATEWAY_PORT} >> ${DEFAULT_GATEWAY_LOG_PATH} 2>&1`,
  ].join('\n')

  const { stderr } = await execFileAsync('docker', [
    'exec',
    '-d',
    containerName,
    'bash',
    '-lc',
    gatewayCommand,
  ])

  if (stderr.trim()) {
    throw new Error(stderr.trim())
  }
}

export async function stopGatewayInContainer(containerName: string): Promise<void> {
  const { stderr } = await execFileAsync('docker', [
    'exec',
    containerName,
    'bash',
    '-lc',
    `pkill -f 'node dist/index.js gateway' || true`,
  ])

  if (stderr.trim()) {
    throw new Error(stderr.trim())
  }
}

export async function waitForGatewayReady(
  containerName: string,
  timeoutMs = DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS,
  delayMs = DEFAULT_GATEWAY_STARTUP_POLL_MS,
): Promise<void> {
  await waitForGatewayPortState(
    containerName,
    'listening',
    timeoutMs,
    delayMs,
    `Timed out waiting for gateway on ${DEFAULT_GATEWAY_URL} after ${Math.round(timeoutMs / 1000)}s. Inspect logs with: npm run tempclaw -- openclaw logs`,
  )
}

export async function waitForGatewayStopped(
  containerName: string,
  timeoutMs = DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS,
  delayMs = DEFAULT_GATEWAY_STARTUP_POLL_MS,
): Promise<void> {
  await waitForGatewayPortState(
    containerName,
    'stopped',
    timeoutMs,
    delayMs,
    `Timed out waiting for gateway on ${DEFAULT_GATEWAY_URL} to stop after ${Math.round(timeoutMs / 1000)}s.`,
  )
}

export async function attachTuiToContainer(options: {
  containerName: string
  token?: string
}): Promise<void> {
  const args = [
    'node',
    'dist/index.js',
    'tui',
    '--url',
    DEFAULT_GATEWAY_URL,
  ]
  if (options.token) {
    args.push('--token', options.token)
  }

  const code = await runContainerCommand(options.containerName, args, { interactive: true })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

export async function runContainerCommand(
  containerName: string,
  command: string[],
  options: {
    interactive?: boolean
    stdio?: 'inherit' | 'ignore'
  } = {},
): Promise<number> {
  const dockerArgs = ['exec']
  if (options.interactive) {
    dockerArgs.push('-it')
  }
  dockerArgs.push(containerName, ...command)
  return spawnAndWait('docker', dockerArgs, options.stdio)
}

export async function cleanupContainerIfExists(containerName: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
}

async function waitForGatewayPortState(
  containerName: string,
  targetState: 'listening' | 'stopped',
  timeoutMs: number,
  delayMs: number,
  timeoutMessage: string,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / delayMs))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = await runContainerCommand(
      containerName,
      [
        'node',
        '-e',
        `const net=require("net"); const s=net.connect(${DEFAULT_GATEWAY_PORT}, "127.0.0.1"); s.on("connect",()=>{s.end(); process.exit(0)}); s.on("error",()=>{process.exit(1)});`,
      ],
      { stdio: 'ignore' },
    )
    if (targetState === 'listening' ? code === 0 : code !== 0) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }

  throw new Error(timeoutMessage)
}

function buildContainerEnvArgs(token: string | undefined, extraEnv: Record<string, string>): string[] {
  const envArgs: string[] = [
    '-e', 'HOME=/home/node',
    '-e', 'TERM=xterm-256color',
    '-e', 'OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json',
    '-e', 'OPENCLAW_STATE_DIR=/home/node/.openclaw',
    '-e', 'OPENCLAW_WORKSPACE_DIR=/workspace',
  ]

  if (token) {
    envArgs.push('-e', `OPENCLAW_GATEWAY_TOKEN=${token}`)
  }
  if (process.env.OPENAI_API_KEY) {
    envArgs.push('-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`)
  }
  if (process.env.ANTHROPIC_API_KEY) {
    envArgs.push('-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`)
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    envArgs.push('-e', `${key}=${value}`)
  }

  return envArgs
}

function spawnAndWait(cmd: string, args: string[], stdio: 'inherit' | 'ignore' = 'inherit'): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}
