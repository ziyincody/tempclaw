import {
  captureContainerCommand,
  runContainerCommand,
  runDetachedContainerCommand,
} from './framework-docker.js'

export const DEFAULT_GATEWAY_PORT = 18789
export const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`
export const DEFAULT_GATEWAY_LOG_PATH = '/home/node/.openclaw/tempclaw-gateway.log'
const DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_GATEWAY_STARTUP_POLL_MS = 500

export async function startGatewayInContainer(containerName: string): Promise<void> {
  const gatewayCommand = [
    'set -euo pipefail',
    `node dist/index.js gateway --allow-unconfigured --bind loopback --port ${DEFAULT_GATEWAY_PORT} >> ${DEFAULT_GATEWAY_LOG_PATH} 2>&1`,
  ].join('\n')

  await runDetachedContainerCommand(containerName, ['bash', '-lc', gatewayCommand])
}

export async function stopGatewayInContainer(containerName: string): Promise<void> {
  const stopCommand = [
    'set -euo pipefail',
    'pids=$(ps -eo pid=,comm= | awk \'index($2, "openclaw-gatewa") == 1 {print $1}\')',
    'if [ -n "$pids" ]; then kill $pids; fi',
  ].join('\n')

  const { stderr } = await captureContainerCommand(containerName, ['bash', '-lc', stopCommand])
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

export async function isGatewayReady(
  containerName: string,
  timeoutMs = 1_000,
  delayMs = 250,
): Promise<boolean> {
  try {
    await waitForGatewayReady(containerName, timeoutMs, delayMs)
    return true
  } catch {
    return false
  }
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
  const args = ['node', 'dist/index.js', 'tui', '--url', DEFAULT_GATEWAY_URL]
  if (options.token) {
    args.push('--token', options.token)
  }

  const code = await runContainerCommand(options.containerName, args, { interactive: true })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
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
