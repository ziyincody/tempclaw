import {
  captureContainerCommand,
  runContainerCommand,
  runDetachedContainerCommand,
} from './framework-docker.js'
import {
  getHermesBootstrapCommand,
  getHermesBootstrapReadyCommand,
  getHermesGatewayCommand,
  getHermesGatewayReadyCommand,
  getHermesGatewayStopCommand,
  getHermesLogPath,
} from './hermes-runtime.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 500

export async function bootstrapHermesInContainer(containerName: string): Promise<void> {
  await runContainerCommand(containerName, ['bash', '-lc', getHermesBootstrapCommand()])
}

export async function startHermesGatewayInContainer(containerName: string): Promise<void> {
  await runDetachedContainerCommand(containerName, ['bash', '-lc', getHermesGatewayCommand()], {
    workdir: '/workspace',
  })
}

export async function stopHermesGatewayInContainer(containerName: string): Promise<void> {
  const { stderr } = await captureContainerCommand(containerName, ['bash', '-lc', getHermesGatewayStopCommand()])
  if (stderr.trim()) {
    throw new Error(stderr.trim())
  }
}

export async function waitForHermesBootstrapReady(
  containerName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_POLL_MS,
): Promise<void> {
  await waitForCommandSuccess(
    containerName,
    getHermesBootstrapReadyCommand(),
    timeoutMs,
    delayMs,
    `Timed out waiting for Hermes bootstrap in ${containerName} after ${Math.round(timeoutMs / 1000)}s.`,
  )
}

export async function isHermesBootstrapReady(
  containerName: string,
  timeoutMs = 1_000,
  delayMs = 250,
): Promise<boolean> {
  try {
    await waitForHermesBootstrapReady(containerName, timeoutMs, delayMs)
    return true
  } catch {
    return false
  }
}

export async function waitForHermesGatewayReady(
  containerName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_POLL_MS,
): Promise<void> {
  await waitForCommandSuccess(
    containerName,
    getHermesGatewayReadyCommand(),
    timeoutMs,
    delayMs,
    `Timed out waiting for Hermes gateway in ${containerName} after ${Math.round(timeoutMs / 1000)}s.`,
  )
}

export async function isHermesGatewayReady(
  containerName: string,
  timeoutMs = 1_000,
  delayMs = 250,
): Promise<boolean> {
  try {
    await waitForHermesGatewayReady(containerName, timeoutMs, delayMs)
    return true
  } catch {
    return false
  }
}

export async function waitForHermesGatewayStopped(
  containerName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_POLL_MS,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / delayMs))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await isHermesGatewayReady(containerName, delayMs, Math.max(100, Math.min(delayMs, 250)))
    if (!ready) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }

  throw new Error(`Timed out waiting for Hermes gateway in ${containerName} to stop after ${Math.round(timeoutMs / 1000)}s.`)
}

export async function attachHermesTuiToContainer(containerName: string): Promise<void> {
  const code = await runContainerCommand(
    containerName,
    ['/opt/hermes/.venv/bin/hermes'],
    {
      interactive: true,
      workdir: '/workspace',
      env: {
        HERMES_HOME: '/opt/data',
        HOME: '/opt/data/home',
      },
    },
  )
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

export async function runHermesLogs(
  containerName: string,
  component: string | undefined,
  lines: number,
  follow: boolean,
): Promise<void> {
  const command = ['tail', '-n', String(lines)]
  if (follow) {
    command.push('-f')
  }
  command.push(getHermesLogPath(component))

  const code = await runContainerCommand(containerName, command, {
    interactive: follow && process.stdin.isTTY && process.stdout.isTTY,
  })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

async function waitForCommandSuccess(
  containerName: string,
  bashCommand: string,
  timeoutMs: number,
  delayMs: number,
  timeoutMessage: string,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / delayMs))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = await runContainerCommand(containerName, ['bash', '-lc', bashCommand], { stdio: 'ignore' })
    if (code === 0) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }

  throw new Error(timeoutMessage)
}
