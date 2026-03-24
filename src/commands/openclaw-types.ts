export type OpenClawArgs = {
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

export type RuntimeDirs = {
  root: string
  stateDir: string
  workspaceDir: string
  configPath: string
  execApprovalsPath: string
}

export type PluginMount = {
  hostPath: string
  containerPath: string
}

export type MountPath = {
  hostPath: string
  containerPath: string
}

export type PreparedRuntime = {
  image: string
  token?: string
  runtime: RuntimeDirs
  pluginMounts: PluginMount[]
  extraMounts: MountPath[]
  extraEnv: Record<string, string>
}

export type OpenClawSession = {
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
