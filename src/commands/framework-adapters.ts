import { runContainerCommand } from './framework-docker.js'
import {
  attachHermesTuiToContainer,
  bootstrapHermesInContainer,
  isHermesBootstrapReady,
  isHermesGatewayReady,
  runHermesLogs,
  startHermesGatewayInContainer,
  stopHermesGatewayInContainer,
  waitForHermesBootstrapReady,
  waitForHermesGatewayReady,
  waitForHermesGatewayStopped,
} from './hermes-docker.js'
import { getHermesLogPath, prepareHermesRuntime } from './hermes-runtime.js'
import {
  attachTuiToContainer,
  DEFAULT_GATEWAY_LOG_PATH,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_URL,
  isGatewayReady,
  startGatewayInContainer,
  stopGatewayInContainer,
  waitForGatewayReady,
  waitForGatewayStopped,
} from './openclaw-docker.js'
import { prepareOpenClawRuntime } from './openclaw-runtime.js'
import type {
  FrameworkAdapter,
  FrameworkAdapterMap,
  FrameworkSession,
  HermesArgs,
  HermesLogsArgs,
  LogsArgs,
  OpenClawArgs,
  PreparedFrameworkRuntime,
} from './framework-types.js'

export class UnmanagedRuntimeError extends Error {}

const openClawSharedArgs = {
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

const hermesSharedArgs = {
  hermesPath: { type: 'string', description: 'Path to the Hermes repo', default: '../hermes-agent' },
  image: { type: 'string', description: 'Docker image tag to build/run', default: 'hermes-agent:local' },
  skipBuild: { type: 'boolean', description: 'Skip Docker build and run the image directly' },
  configPath: { type: 'string', description: 'Path to a Hermes config file (config.yaml)' },
  mountPath: {
    type: 'string',
    description: 'Extra read-only mount(s) as hostPath:containerPath[,hostPath:containerPath...]',
  },
  env: {
    type: 'string',
    description: 'Extra container env var(s) as KEY=value[,KEY=value...]',
  },
  startGateway: { type: 'boolean', description: 'Start and manage a Hermes gateway in the sandbox' },
} as const

const defaultLogsArgs = {
  follow: { type: 'boolean', description: 'Follow log output' },
  lines: { type: 'string', description: 'Number of log lines to show', default: '200' },
} as const

const hermesLogsArgs = {
  ...defaultLogsArgs,
  component: { type: 'string', description: 'Hermes log component (agent|gateway|errors)', default: 'agent' },
} as const

export const openClawAdapter: FrameworkAdapter<OpenClawArgs, LogsArgs> = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  description: 'Run a persistent OpenClaw sandbox lifecycle inside Docker',
  args: openClawSharedArgs,
  logsArgs: defaultLogsArgs,
  prepareRuntime: prepareOpenClawRuntime,
  async start(session, prepared) {
    void prepared
    await startGatewayInContainer(session.containerName)
  },
  waitForReady(session) {
    return waitForGatewayReady(session.containerName)
  },
  isReady(session, timeoutMs, delayMs) {
    return isGatewayReady(session.containerName, timeoutMs, delayMs)
  },
  async attachTui(session) {
    await attachTuiToContainer({
      containerName: session.containerName,
    })
  },
  async runLogs(session, args) {
    const lines = normalizeLogLines(args.lines)
    const command = ['tail', '-n', String(lines)]
    if (args.follow) {
      command.push('-f')
    }
    command.push(DEFAULT_GATEWAY_LOG_PATH)

    const code = await runContainerCommand(session.containerName, command, {
      interactive: Boolean(args.follow && process.stdin.isTTY && process.stdout.isTTY),
    })
    if (code !== 0) {
      throw new Error(`docker exec failed (exit ${code})`)
    }
  },
  async restart(session) {
    await stopGatewayInContainer(session.containerName)
    await waitForGatewayStopped(session.containerName)
    await startGatewayInContainer(session.containerName)
  },
  printSessionReady(session) {
    console.log(`Container: ${session.containerName}`)
    console.log(`Gateway: ${session.gatewayUrl ?? DEFAULT_GATEWAY_URL}`)
    console.log(`Gateway log: ${session.logPath}`)
    console.log('Next steps:')
    console.log('  npm run tempclaw -- openclaw tui')
    console.log('  npm run tempclaw -- openclaw logs')
    console.log('  npm run tempclaw -- openclaw restart')
    console.log('  npm run tempclaw -- openclaw exec -- openclaw plugins list')
    console.log('  npm run tempclaw -- openclaw down')
  },
}

export const hermesAdapter: FrameworkAdapter<HermesArgs, HermesLogsArgs> = {
  id: 'hermes',
  displayName: 'Hermes',
  description: 'Run a persistent Hermes sandbox lifecycle inside Docker',
  args: hermesSharedArgs,
  logsArgs: hermesLogsArgs,
  prepareRuntime: prepareHermesRuntime,
  async start(session, prepared) {
    await bootstrapHermesInContainer(session.containerName)
    if (prepared.managedProcess === 'gateway') {
      await startHermesGatewayInContainer(session.containerName)
    }
  },
  async waitForReady(session) {
    await waitForHermesBootstrapReady(session.containerName)
    if (session.managedProcess === 'gateway') {
      await waitForHermesGatewayReady(session.containerName)
    }
  },
  async isReady(session, timeoutMs, delayMs) {
    const bootstrapReady = await isHermesBootstrapReady(session.containerName, timeoutMs, delayMs)
    if (!bootstrapReady) {
      return false
    }
    if (session.managedProcess === 'gateway') {
      return isHermesGatewayReady(session.containerName, timeoutMs, delayMs)
    }
    return true
  },
  attachTui(session) {
    return attachHermesTuiToContainer(session.containerName)
  },
  async runLogs(session, args) {
    await runHermesLogs(session.containerName, args.component, normalizeLogLines(args.lines), args.follow ?? false)
  },
  async restart(session) {
    if (session.managedProcess !== 'gateway') {
      throw new UnmanagedRuntimeError('No managed Hermes gateway is running in this sandbox.')
    }
    await stopHermesGatewayInContainer(session.containerName)
    await waitForHermesGatewayStopped(session.containerName)
    await startHermesGatewayInContainer(session.containerName)
  },
  printSessionReady(session) {
    console.log(`Container: ${session.containerName}`)
    console.log(`Home: ${session.homeDir}`)
    console.log(`Log: ${session.logPath}`)
    console.log('Next steps:')
    console.log('  npm run tempclaw -- hermes tui')
    console.log('  npm run tempclaw -- hermes logs')
    if (session.managedProcess === 'gateway') {
      console.log('  npm run tempclaw -- hermes restart')
      console.log(`  npm run tempclaw -- hermes logs --component gateway`)
    }
    console.log('  npm run tempclaw -- hermes exec -- /opt/hermes/.venv/bin/hermes logs')
    console.log('  npm run tempclaw -- hermes down')
  },
}

export const frameworkAdapters: FrameworkAdapterMap = {
  openclaw: openClawAdapter,
  hermes: hermesAdapter,
}

export function buildFrameworkSession(
  framework: 'openclaw' | 'hermes',
  containerName: string,
  prepared: PreparedFrameworkRuntime,
): FrameworkSession {
  return {
    version: 2,
    framework,
    containerName,
    lifecycleState: 'starting',
    lifecyclePid: process.pid,
    managedProcess: prepared.managedProcess,
    image: prepared.image,
    runtimeRoot: prepared.runtime.root,
    stateDir: prepared.runtime.stateDir,
    workspaceDir: prepared.runtime.workspaceDir,
    homeDir: prepared.homeDir,
    workdir: prepared.workdir,
    logPath: prepared.logPath,
    createdAt: new Date().toISOString(),
    extraMounts: prepared.extraMounts,
    configPath: prepared.configPath,
    execApprovalsPath: prepared.execApprovalsPath,
    pluginMounts: prepared.pluginMounts,
    gatewayPort: prepared.gatewayPort,
    gatewayUrl: prepared.gatewayUrl,
  }
}

function normalizeLogLines(lines?: string): number {
  const raw = lines?.trim() || '200'
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid log line count "${lines}". Use a positive integer.`)
  }
  return parsed
}
