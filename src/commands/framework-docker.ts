import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ContainerMount, RuntimeDirs } from './framework-types.js'

const execFileAsync = promisify(execFile)
const DEFAULT_KEEPALIVE_COMMAND = 'trap "exit 0" TERM INT; while true; do sleep 3600; done'

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
  runtime: RuntimeDirs
  stateContainerPath: string
  workspaceContainerPath: string
  mounts: ContainerMount[]
  env: Record<string, string>
  containerName: string
  entrypoint?: string
  command?: string[]
}): Promise<void> {
  const envArgs = buildContainerEnvArgs(options.env)
  const mountArgs = options.mounts.flatMap((mount) => [
    '-v',
    formatMount(mount),
  ])
  const args = [
    'run',
    '-d',
    '--name',
    options.containerName,
    '-v',
    `${options.runtime.stateDir}:${options.stateContainerPath}`,
    '-v',
    `${options.runtime.workspaceDir}:${options.workspaceContainerPath}`,
    ...mountArgs,
    ...envArgs,
  ]

  if (options.entrypoint) {
    args.push('--entrypoint', options.entrypoint)
  }

  args.push(options.image, ...(options.command ?? ['bash', '-lc', DEFAULT_KEEPALIVE_COMMAND]))

  const { stdout } = await execFileAsync('docker', args)
  if (!stdout.trim()) {
    throw new Error('docker run did not return a container id')
  }
}

export async function runContainerCommand(
  containerName: string,
  command: string[],
  options: {
    interactive?: boolean
    stdio?: 'inherit' | 'ignore'
    workdir?: string
    env?: Record<string, string>
  } = {},
): Promise<number> {
  const dockerArgs = buildExecArgs(containerName, command, options)
  return spawnAndWait('docker', dockerArgs, options.stdio)
}

export async function runDetachedContainerCommand(
  containerName: string,
  command: string[],
  options: {
    workdir?: string
    env?: Record<string, string>
  } = {},
): Promise<void> {
  const { stderr } = await execFileAsync('docker', buildExecArgs(containerName, command, {
    ...options,
    detached: true,
  }))
  if (stderr.trim()) {
    throw new Error(stderr.trim())
  }
}

export async function captureContainerCommand(
  containerName: string,
  command: string[],
  options: {
    workdir?: string
    env?: Record<string, string>
  } = {},
): Promise<{ stdout: string, stderr: string }> {
  return execFileAsync('docker', buildExecArgs(containerName, command, options))
}

export async function cleanupContainerIfExists(containerName: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
}

export async function inspectContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', containerName])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

function buildExecArgs(
  containerName: string,
  command: string[],
  options: {
    interactive?: boolean
    stdio?: 'inherit' | 'ignore'
    workdir?: string
    env?: Record<string, string>
    detached?: boolean
  },
): string[] {
  const dockerArgs = ['exec']
  if (options.detached) {
    dockerArgs.push('-d')
  }
  if (options.interactive) {
    dockerArgs.push('-it')
  }
  if (options.workdir) {
    dockerArgs.push('-w', options.workdir)
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    dockerArgs.push('-e', `${key}=${value}`)
  }
  dockerArgs.push(containerName, ...command)
  return dockerArgs
}

function buildContainerEnvArgs(env: Record<string, string>): string[] {
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(env)) {
    envArgs.push('-e', `${key}=${value}`)
  }
  return envArgs
}

function formatMount(mount: ContainerMount): string {
  return `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ':ro' : ''}`
}

function spawnAndWait(cmd: string, args: string[], stdio: 'inherit' | 'ignore' = 'inherit'): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}
