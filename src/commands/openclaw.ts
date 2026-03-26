import { defineCommand } from 'citty'
import { randomBytes } from 'node:crypto'
import { readGatewayTokenFromConfigPath } from '../openclaw/config.js'
import {
  attachTuiToContainer,
  cleanupContainerIfExists,
  createDetachedContainer,
  DEFAULT_GATEWAY_LOG_PATH,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_URL,
  runContainerCommand,
  startGatewayInContainer,
  stopGatewayInContainer,
  waitForGatewayReady,
  waitForGatewayStopped,
} from './openclaw-docker.js'
import { clearSession, ensureNoActiveSession, readSession, requireRunningSession, writeSession } from './openclaw-session.js'
import { cleanupRuntimeDirs, prepareRuntime } from './openclaw-runtime.js'
import type { OpenClawArgs, OpenClawSession } from './openclaw-types.js'

const LIFECYCLE_SUBCOMMANDS = new Set(['up', 'tui', 'exec', 'logs', 'restart', 'down'])

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

const logsArgs = {
  follow: { type: 'boolean', description: 'Follow log output' },
  lines: { type: 'string', description: 'Number of log lines to show', default: '200' },
} as const

type LogsArgs = {
  follow?: boolean
  lines?: string
}

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
        await runOrExit(() => runPersistentUp(args as OpenClawArgs))
      },
    }),
    tui: defineCommand({
      meta: { name: 'tui', description: 'Attach the TUI to the running sandbox gateway' },
      async run() {
        await runOrExit(runPersistentTui)
      },
    }),
    exec: defineCommand({
      meta: { name: 'exec', description: 'Run a command inside the running sandbox container' },
      async run() {
        await runOrExit(runPersistentExec)
      },
    }),
    logs: defineCommand({
      meta: { name: 'logs', description: 'View gateway logs from the running sandbox' },
      args: logsArgs,
      async run({ args }) {
        await runOrExit(() => runPersistentLogs(args as LogsArgs))
      },
    }),
    restart: defineCommand({
      meta: { name: 'restart', description: 'Restart the gateway inside the running sandbox' },
      async run() {
        await runOrExit(runPersistentRestart)
      },
    }),
    down: defineCommand({
      meta: { name: 'down', description: 'Stop the running sandbox and remove temp state' },
      async run() {
        await runOrExit(runPersistentDown)
      },
    }),
  },
  async run({ args }) {
    // citty still invokes the parent command handler after subcommand resolution.
    if (isLifecycleSubcommandInvocation()) {
      return
    }
    void args
    throw new Error('Missing subcommand. Use one of: up, tui, exec, logs, restart, down.')
  },
})

async function runPersistentUp(args: OpenClawArgs): Promise<void> {
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
    await startGatewayInContainer(containerName)
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
    console.log('  npm run tempclaw -- openclaw logs')
    console.log('  npm run tempclaw -- openclaw restart')
    console.log('  npm run tempclaw -- openclaw exec -- openclaw plugins list')
    console.log('  npm run tempclaw -- openclaw down')
  } catch (error) {
    await cleanupContainerIfExists(containerName)
    await cleanupRuntimeDirs(prepared.runtime.root)
    throw error
  }
}

async function runPersistentTui(): Promise<void> {
  const session = await requireRunningSession()
  await attachTuiToContainer({
    containerName: session.containerName,
    token: await readGatewayTokenFromConfigPath(session.configPath),
  })
}

async function runPersistentExec(): Promise<void> {
  const session = await requireRunningSession()
  const command = extractExecCommand()
  if (command.length === 0) {
    throw new Error('Missing command. Use: tempclaw openclaw exec -- <command...>')
  }

  const code = await runContainerCommand(session.containerName, command, {
    interactive: process.stdin.isTTY && process.stdout.isTTY,
  })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

async function runPersistentLogs(args: LogsArgs): Promise<void> {
  const session = await requireRunningSession()
  const lines = normalizeLogLines(args.lines)
  const follow = args.follow ?? false
  const command = ['tail', '-n', String(lines)]
  if (follow) {
    command.push('-f')
  }
  command.push(DEFAULT_GATEWAY_LOG_PATH)

  const code = await runContainerCommand(session.containerName, command, {
    interactive: follow && process.stdin.isTTY && process.stdout.isTTY,
  })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

async function runPersistentRestart(): Promise<void> {
  const session = await requireRunningSession()
  await stopGatewayInContainer(session.containerName)
  await waitForGatewayStopped(session.containerName)
  await startGatewayInContainer(session.containerName)
  await waitForGatewayReady(session.containerName)
  console.log(`Restarted gateway in ${session.containerName}`)
}

async function runPersistentDown(): Promise<void> {
  const session = await readSession()
  if (!session) {
    console.log('No active tempclaw OpenClaw session.')
    return
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
  console.log(`Removed sandbox ${session.containerName}`)
}

function normalizeLogLines(lines?: string): number {
  const raw = lines?.trim() || '200'
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid log line count "${lines}". Use a positive integer.`)
  }
  return parsed
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

async function runOrExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
