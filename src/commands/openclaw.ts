import { defineCommand } from 'citty'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  writeExecApprovals,
  writeRuntimeConfigFromPath,
  writeRuntimeConfigFromTemplate,
} from '../openclaw/config.js'

const execFileAsync = promisify(execFile)
const SESSION_FILE_PATH = join(tmpdir(), 'tempclaw-openclaw-session.json')
const DEFAULT_GATEWAY_PORT = 18789
const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`
const DEFAULT_KEEPALIVE_COMMAND = 'trap "exit 0" TERM INT; while true; do sleep 3600; done'
const DEFAULT_GATEWAY_LOG_PATH = '/home/node/.openclaw/tempclaw-gateway.log'
const DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_GATEWAY_STARTUP_POLL_MS = 500
const LIFECYCLE_SUBCOMMANDS = new Set(['up', 'tui', 'exec', 'down'])

const sharedArgs = {
  openclawPath: { type: 'string', description: 'Path to the OpenClaw repo', default: '../openclaw' },
  image: { type: 'string', description: 'Docker image tag to build/run', default: 'openclaw:local' },
  skipBuild: { type: 'boolean', description: 'Skip Docker build and run the image directly' },
  configPath: { type: 'string', description: 'Path to an OpenClaw config file (openclaw.json)' },
  pluginPath: { type: 'string', description: 'Path to a local OpenClaw plugin repo to mount and load' },
  mountPath: {
    type: 'string',
    description: 'Extra read-only mount(s) as hostPath:containerPath[,hostPath:containerPath...]',
  },
  providerBaseUrl: {
    type: 'string',
    description: 'Provider base URL override(s) as provider=url[,provider=url...]',
  },
  env: {
    type: 'string',
    description: 'Extra container env var(s) as KEY=value[,KEY=value...]',
  },
  token: { type: 'string', description: 'Gateway token to use (defaults to random)' },
  model: { type: 'string', description: 'Default model (provider/model) for the session' },
  thinking: { type: 'string', description: 'Thinking level (off|minimal|low|medium|high|xhigh)' },
  verbose: { type: 'string', description: 'Verbose level (off|on|full)' },
} as const

export default defineCommand({
  meta: {
    name: 'openclaw',
    description: 'Run a persistent OpenClaw sandbox lifecycle inside Docker',
  },
  args: sharedArgs,
  subCommands: {
    up: defineCommand({
      meta: { name: 'up', description: 'Start a persistent OpenClaw sandbox container and gateway' },
      args: sharedArgs,
      async run({ args }) {
        await runPersistentUp(args as OpenClawArgs)
      },
    }),
    tui: defineCommand({
      meta: { name: 'tui', description: 'Attach the TUI to the running sandbox gateway' },
      async run({ args }) {
        await runPersistentTui(args as Pick<OpenClawArgs, never>)
      },
    }),
    exec: defineCommand({
      meta: { name: 'exec', description: 'Run a command inside the running sandbox container' },
      async run() {
        await runPersistentExec()
      },
    }),
    down: defineCommand({
      meta: { name: 'down', description: 'Stop the running sandbox and remove temp state' },
      async run() {
        await runPersistentDown()
      },
    }),
  },
  async run({ args }) {
    if (isLifecycleSubcommandInvocation()) {
      return
    }
    void args
    throw new Error('Missing subcommand. Use one of: up, tui, exec, down.')
  },
})

type OpenClawArgs = {
  openclawPath?: string
  image?: string
  skipBuild?: boolean
  configPath?: string
  pluginPath?: string
  mountPath?: string
  providerBaseUrl?: string
  env?: string
  token?: string
  model?: string
  thinking?: string
  verbose?: string
}

type RuntimeDirs = {
  root: string
  stateDir: string
  workspaceDir: string
  configPath: string
  execApprovalsPath: string
}

type PluginMount = {
  hostPath: string
  containerPath: string
}

type MountPath = {
  hostPath: string
  containerPath: string
}

type PreparedRuntime = {
  image: string
  token?: string
  runtime: RuntimeDirs
  pluginMounts: PluginMount[]
  extraMounts: MountPath[]
  extraEnv: Record<string, string>
}

type OpenClawSession = {
  version: 1
  containerName: string
  image: string
  gatewayPort: number
  gatewayUrl: string
  gatewayLogPath: string
  runtimeRoot: string
  stateDir: string
  workspaceDir: string
  configPath: string
  execApprovalsPath: string
  pluginMounts: PluginMount[]
  extraMounts: MountPath[]
  createdAt: string
}

async function runPersistentUp(args: OpenClawArgs): Promise<void> {
  try {
    await ensureNoActiveSession()
    const prepared = await prepareRuntime(args)
    const containerName = `tempclaw-openclaw-${randomBytes(4).toString('hex')}`

    try {
      await createDetachedContainer({
        image: prepared.image,
        token: prepared.token,
        runtime: prepared.runtime,
        pluginMounts: prepared.pluginMounts,
        extraMounts: prepared.extraMounts,
        extraEnv: prepared.extraEnv,
        containerName,
      })
      await startGatewayInContainer({
        containerName,
      })
      await waitForGatewayReady(containerName)

      const session: OpenClawSession = {
        version: 1,
        containerName,
        image: prepared.image,
        gatewayPort: DEFAULT_GATEWAY_PORT,
        gatewayUrl: DEFAULT_GATEWAY_URL,
        gatewayLogPath: DEFAULT_GATEWAY_LOG_PATH,
        runtimeRoot: prepared.runtime.root,
        stateDir: prepared.runtime.stateDir,
        workspaceDir: prepared.runtime.workspaceDir,
        configPath: prepared.runtime.configPath,
        execApprovalsPath: prepared.runtime.execApprovalsPath,
        pluginMounts: prepared.pluginMounts,
        extraMounts: prepared.extraMounts,
        createdAt: new Date().toISOString(),
      }
      await writeSession(session)

      console.log(`Container: ${session.containerName}`)
      console.log(`Gateway: ${session.gatewayUrl}`)
      console.log(`Gateway log: ${session.gatewayLogPath}`)
      console.log('Next steps:')
      console.log('  npm run tempclaw -- openclaw tui')
      console.log('  npm run tempclaw -- openclaw exec -- openclaw plugins list')
      console.log('  npm run tempclaw -- openclaw down')
    } catch (error) {
      await cleanupContainerIfExists(containerName)
      await cleanupRuntimeDirs(prepared.runtime.root)
      throw error
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function runPersistentTui(_args: Pick<OpenClawArgs, never>): Promise<void> {
  try {
    const session = await requireRunningSession()
    await attachTuiToContainer({
      containerName: session.containerName,
      token: await readRuntimeGatewayToken(session.configPath),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function runPersistentExec(): Promise<void> {
  try {
    const session = await requireRunningSession()
    const command = extractExecCommand()
    if (command.length === 0) {
      throw new Error('Missing command. Use: tempclaw openclaw exec -- <command...>')
    }
    const dockerArgs = ['exec']
    if (process.stdin.isTTY && process.stdout.isTTY) {
      dockerArgs.push('-it')
    }
    dockerArgs.push(session.containerName, ...command)
    const code = await spawnAndWait('docker', dockerArgs)
    if (code !== 0) {
      throw new Error(`docker exec failed (exit ${code})`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function runPersistentDown(): Promise<void> {
  try {
    const session = await readSession()
    if (!session) {
      console.log('No active tempclaw OpenClaw session.')
      return
    }

    await cleanupContainerIfExists(session.containerName)
    await cleanupRuntimeDirs(session.runtimeRoot)
    await clearSession()
    console.log(`Removed sandbox ${session.containerName}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function prepareRuntime(args: OpenClawArgs): Promise<PreparedRuntime> {
  const normalizedModel = normalizeModel(args.model)
  const normalizedThinking = normalizeThinking(args.thinking)
  const normalizedVerbose = normalizeVerbose(args.verbose)
  const shouldBuild = !args.skipBuild
  const openclawPath = resolve(args.openclawPath ?? '../openclaw')
  const dockerfilePath = resolve(openclawPath, 'Dockerfile')
  const resolvedConfigPath = args.configPath ? resolve(args.configPath) : undefined
  const explicitPluginPath = args.pluginPath ? resolve(args.pluginPath) : undefined
  const extraMounts = parseMountPaths(args.mountPath)
  const providerBaseUrls = parseProviderBaseUrls(args.providerBaseUrl)
  const extraEnv = parseContainerEnv(args.env) ?? {}
  const templatePath = resolve(process.cwd(), 'assets', 'openclaw', 'openclaw.json')

  if (shouldBuild) {
    await ensureExists(openclawPath, `OpenClaw path not found: ${openclawPath}`)
    await ensureExists(dockerfilePath, `OpenClaw Dockerfile not found: ${dockerfilePath}`)
  }

  await ensureDockerAvailable()
  if (resolvedConfigPath) {
    await ensureExists(resolvedConfigPath, `OpenClaw config not found: ${resolvedConfigPath}`)
  } else {
    await ensureExists(templatePath, `OpenClaw template config not found: ${templatePath}`)
  }
  if (explicitPluginPath) {
    await ensureExists(explicitPluginPath, `OpenClaw plugin path not found: ${explicitPluginPath}`)
  }
  for (const mount of extraMounts) {
    await ensureExists(mount.hostPath, `Mount path not found: ${mount.hostPath}`)
  }

  const pluginMounts = explicitPluginPath ? createPluginMounts([explicitPluginPath]) : []
  const pluginAllowIds = explicitPluginPath
    ? (await Promise.all(pluginMounts.map((mount) => resolvePluginId(mount.hostPath)))).filter(
        (value): value is string => Boolean(value),
      )
    : []
  const token = args.token?.trim().length
    ? args.token.trim()
    : (resolvedConfigPath ? undefined : randomBytes(16).toString('hex'))

  if (shouldBuild) {
    await runDockerBuild({ image: args.image ?? 'openclaw:local', dockerfilePath, contextDir: openclawPath })
  }

  const runtime = await createRuntimeDirs()
  let resolvedToken: string | undefined
  if (resolvedConfigPath) {
    resolvedToken = await writeRuntimeConfigFromPath(runtime.configPath, resolvedConfigPath, {
      token,
      model: normalizedModel,
      thinking: normalizedThinking,
      verbose: normalizedVerbose,
      pluginLoadPaths: pluginMounts.map((mount) => mount.containerPath),
      pluginAllowIds,
      providerBaseUrls,
    })
  } else if (token) {
    resolvedToken = await writeRuntimeConfigFromTemplate(runtime.configPath, templatePath, {
      token,
      model: normalizedModel,
      thinking: normalizedThinking,
      verbose: normalizedVerbose,
      pluginLoadPaths: pluginMounts.map((mount) => mount.containerPath),
      pluginAllowIds,
      providerBaseUrls,
    })
  } else {
    throw new Error('Missing gateway token (provide --token or use --configPath with token)')
  }
  await writeExecApprovals(runtime.execApprovalsPath)

  return {
    image: args.image ?? 'openclaw:local',
    token: resolvedToken,
    runtime,
    pluginMounts,
    extraMounts,
    extraEnv,
  }
}

async function ensureExists(path: string, message: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(message)
  }
}

async function resolvePluginId(pluginPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(pluginPath, 'openclaw.plugin.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const id = parsed.id
    return typeof id === 'string' && id.trim().length > 0 ? id : undefined
  } catch {
    return undefined
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

async function createDetachedContainer(options: {
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

async function startGatewayInContainer(options: {
  containerName: string
}): Promise<void> {
  const gatewayCommand = [
    'set -euo pipefail',
    `node dist/index.js gateway --allow-unconfigured --bind loopback --port ${DEFAULT_GATEWAY_PORT} >> ${DEFAULT_GATEWAY_LOG_PATH} 2>&1`,
  ].join('\n')

  const { stderr } = await execFileAsync('docker', [
    'exec',
    '-d',
    options.containerName,
    'bash',
    '-lc',
    gatewayCommand,
  ])

  if (stderr.trim()) {
    throw new Error(stderr.trim())
  }
}

async function waitForGatewayReady(
  containerName: string,
  timeoutMs = DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS,
  delayMs = DEFAULT_GATEWAY_STARTUP_POLL_MS,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / delayMs))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = await spawnAndWait('docker', [
      'exec',
      containerName,
      'node',
      '-e',
      `const net=require("net"); const s=net.connect(${DEFAULT_GATEWAY_PORT}, "127.0.0.1"); s.on("connect",()=>{s.end(); process.exit(0)}); s.on("error",()=>{process.exit(1)});`,
    ], 'ignore')
    if (code === 0) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }

  throw new Error(
    `Timed out waiting for gateway on ${DEFAULT_GATEWAY_URL} after ${Math.round(timeoutMs / 1000)}s. Inspect logs with: npm run tempclaw -- openclaw exec -- cat ${DEFAULT_GATEWAY_LOG_PATH}`,
  )
}

async function attachTuiToContainer(options: {
  containerName: string
  token?: string
}): Promise<void> {
  const args = [
    'exec',
    '-it',
    options.containerName,
    'node',
    'dist/index.js',
    'tui',
    '--url',
    DEFAULT_GATEWAY_URL,
  ]
  if (options.token) {
    args.push('--token', options.token)
  }

  const code = await spawnAndWait('docker', args)
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
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

function createPluginMounts(pluginPaths: string[]): PluginMount[] {
  return pluginPaths.map((hostPath, index) => {
    const suffix = basename(hostPath).replace(/[^a-zA-Z0-9._-]/g, '-')
    return {
      hostPath,
      containerPath: `/plugins/${index}-${suffix || 'plugin'}`,
    }
  })
}

function parseMountPaths(raw?: string): MountPath[] {
  if (!raw) return []

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((assignment) => {
      const separatorIndex = assignment.indexOf(':')
      if (separatorIndex <= 0 || separatorIndex === assignment.length - 1) {
        throw new Error(`Invalid mount path "${assignment}". Use hostPath:containerPath.`)
      }

      const hostPath = resolve(assignment.slice(0, separatorIndex).trim())
      const containerPath = assignment.slice(separatorIndex + 1).trim()
      if (!hostPath || !containerPath) {
        throw new Error(`Invalid mount path "${assignment}". Use hostPath:containerPath.`)
      }
      if (!containerPath.startsWith('/')) {
        throw new Error(`Invalid mount path "${assignment}". Container path must be absolute.`)
      }

      return { hostPath, containerPath }
    })
}

function isLifecycleSubcommandInvocation(): boolean {
  const argv = process.argv.slice(2)
  const openclawIndex = argv.indexOf('openclaw')
  if (openclawIndex === -1) {
    return false
  }
  const next = argv[openclawIndex + 1]
  return typeof next === 'string' && LIFECYCLE_SUBCOMMANDS.has(next)
}

function parseProviderBaseUrls(raw?: string): Record<string, string> | undefined {
  return parseAssignments(raw, 'provider base URL', false)
}

function parseContainerEnv(raw?: string): Record<string, string> | undefined {
  return parseAssignments(raw, 'environment variable', true)
}

function parseAssignments(
  raw: string | undefined,
  label: string,
  validateKey: boolean,
): Record<string, string> | undefined {
  if (!raw) return undefined

  const assignments = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (assignments.length === 0) {
    return undefined
  }

  const parsed: Record<string, string> = {}
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf('=')
    if (separatorIndex <= 0 || separatorIndex === assignment.length - 1) {
      throw new Error(`Invalid ${label} "${assignment}". Use name=value.`)
    }

    const key = assignment.slice(0, separatorIndex).trim()
    const value = assignment.slice(separatorIndex + 1).trim()
    if (!key || !value) {
      throw new Error(`Invalid ${label} "${assignment}". Use name=value.`)
    }
    if (validateKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name "${key}".`)
    }

    parsed[key] = value
  }

  return parsed
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

function normalizeVerbose(verbose?: string): string | undefined {
  if (!verbose) return undefined
  const trimmed = verbose.trim().toLowerCase()
  if (!trimmed) return undefined
  const allowed = ['off', 'on', 'full']
  if (!allowed.includes(trimmed)) {
    throw new Error(`Invalid verbose level "${verbose}". Use one of: ${allowed.join(', ')}.`)
  }
  return trimmed
}

async function readSession(): Promise<OpenClawSession | undefined> {
  try {
    const raw = await readFile(SESSION_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as OpenClawSession
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

async function writeSession(session: OpenClawSession): Promise<void> {
  await writeFile(SESSION_FILE_PATH, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function clearSession(): Promise<void> {
  await rm(SESSION_FILE_PATH, { force: true }).catch(() => undefined)
}

async function inspectContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', containerName])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function ensureNoActiveSession(): Promise<void> {
  const session = await readSession()
  if (!session) return

  const running = await inspectContainerRunning(session.containerName)
  if (running) {
    throw new Error(
      `A tempclaw OpenClaw sandbox is already running (${session.containerName}). Use "npm run tempclaw -- openclaw down" first.`,
    )
  }

  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
}

async function requireRunningSession(): Promise<OpenClawSession> {
  const session = await readSession()
  if (!session) {
    throw new Error('No active tempclaw OpenClaw session. Start one with: npm run tempclaw -- openclaw up')
  }

  const running = await inspectContainerRunning(session.containerName)
  if (!running) {
    await cleanupRuntimeDirs(session.runtimeRoot)
    await clearSession()
    throw new Error('The saved tempclaw OpenClaw session is no longer running. Start a new one with: npm run tempclaw -- openclaw up')
  }

  return session
}

async function cleanupContainerIfExists(containerName: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
}

async function readRuntimeGatewayToken(configPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }

    const gateway = parsed.gateway as Record<string, unknown> | undefined
    const auth = gateway?.auth as Record<string, unknown> | undefined
    const token = auth?.token
    return typeof token === 'string' && token.trim().length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

function extractExecCommand(): string[] {
  const execIndex = process.argv.findIndex((value, index, values) => (
    value === 'exec' && values[index - 1] === 'openclaw'
  ))
  if (execIndex === -1) {
    return []
  }

  const separatorIndex = process.argv.indexOf('--', execIndex)
  if (separatorIndex !== -1) {
    return process.argv.slice(separatorIndex + 1)
  }

  return process.argv.slice(execIndex + 1)
}

async function cleanupRuntimeDirs(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
