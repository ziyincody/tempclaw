export type FrameworkId = 'openclaw' | 'hermes'

export type LifecycleState = 'starting' | 'ready' | 'restarting'

export type ManagedProcess = 'gateway'

export type ContainerMount = {
  hostPath: string
  containerPath: string
  readOnly?: boolean
}

export type PluginMount = ContainerMount

export type RuntimeDirs = {
  root: string
  stateDir: string
  workspaceDir: string
}

export type FrameworkSession = {
  version: 2
  framework: FrameworkId
  containerName: string
  lifecycleState: LifecycleState
  lifecyclePid?: number
  managedProcess?: ManagedProcess
  image: string
  runtimeRoot: string
  stateDir: string
  workspaceDir: string
  homeDir: string
  workdir: string
  logPath: string
  createdAt: string
  extraMounts: ContainerMount[]
  configPath?: string
  execApprovalsPath?: string
  pluginMounts?: PluginMount[]
  gatewayPort?: number
  gatewayUrl?: string
}

export type SharedFrameworkArgs = {
  image?: string
  skipBuild?: boolean
  mountPath?: string
  env?: string
}

export type LogsArgs = {
  follow?: boolean
  lines?: string
}

export type OpenClawArgs = SharedFrameworkArgs & {
  openclawPath?: string
  configPath?: string
  pluginPath?: string
  providerBaseUrl?: string
  token?: string
  model?: string
  thinking?: string
  verbose?: string
}

export type HermesArgs = SharedFrameworkArgs & {
  hermesPath?: string
  configPath?: string
  startGateway?: boolean
}

export type HermesLogsArgs = LogsArgs & {
  component?: string
}

export type PreparedFrameworkRuntime = {
  image: string
  runtime: RuntimeDirs
  stateContainerPath: string
  workspaceContainerPath: string
  homeDir: string
  workdir: string
  logPath: string
  mounts: ContainerMount[]
  env: Record<string, string>
  entrypoint?: string
  command?: string[]
  configPath?: string
  execApprovalsPath?: string
  pluginMounts?: PluginMount[]
  extraMounts: ContainerMount[]
  managedProcess?: ManagedProcess
  gatewayPort?: number
  gatewayUrl?: string
}

export type FrameworkAdapter<TArgs, TLogsArgs> = {
  id: FrameworkId
  displayName: string
  description: string
  args: any
  logsArgs: any
  prepareRuntime(args: TArgs): Promise<PreparedFrameworkRuntime>
  start(session: FrameworkSession, prepared: PreparedFrameworkRuntime): Promise<void>
  waitForReady(session: FrameworkSession): Promise<void>
  isReady(session: FrameworkSession, timeoutMs?: number, delayMs?: number): Promise<boolean>
  attachTui(session: FrameworkSession): Promise<void>
  runLogs(session: FrameworkSession, args: TLogsArgs): Promise<void>
  restart(session: FrameworkSession): Promise<void>
  printSessionReady(session: FrameworkSession): void
}

export type FrameworkAdapterMap = Record<FrameworkId, FrameworkAdapter<any, any>>
