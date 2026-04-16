import { readFile, writeFile } from 'node:fs/promises'

type ConfigOverrides = {
  token?: string
  model?: string
  thinking?: string
  verbose?: string
  pluginLoadPaths?: string[]
  pluginAllowIds?: string[]
  providerBaseUrls?: Record<string, string>
}

export async function writeRuntimeConfigFromTemplate(
  configPath: string,
  templatePath: string,
  overrides: ConfigOverrides,
): Promise<string | undefined> {
  return writeRuntimeConfig(configPath, await readConfigObject(templatePath), overrides)
}

export async function writeRuntimeConfigFromPath(
  configPath: string,
  sourcePath: string,
  overrides: ConfigOverrides,
): Promise<string | undefined> {
  return writeRuntimeConfig(configPath, await readConfigObject(sourcePath), overrides)
}

export async function readGatewayTokenFromConfigPath(configPath: string): Promise<string | undefined> {
  return getGatewayToken(await readConfigObject(configPath))
}

export async function writeExecApprovals(approvalsPath: string): Promise<void> {
  const approvals = {
    version: 1,
    defaults: {
      security: 'full',
      ask: 'off',
      askFallback: 'full',
      autoAllowSkills: true,
    },
    agents: {
      main: {
        security: 'full',
        ask: 'off',
      },
    },
  }
  await writeFile(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8')
}

function applyConfigOverrides(config: Record<string, unknown>, overrides: ConfigOverrides) {
  const gateway = (config.gateway as Record<string, unknown> | undefined) ?? {}
  gateway.mode = 'local'
  config.gateway = gateway

  if (overrides.token) {
    const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {}
    auth.mode = 'token'
    auth.token = overrides.token
    gateway.auth = auth
  }

  if (overrides.model || overrides.thinking || overrides.verbose) {
    const agents = (config.agents as Record<string, unknown> | undefined) ?? {}
    const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {}
    if (overrides.model) {
      const modelConfig = (defaults.model as Record<string, unknown> | undefined) ?? {}
      modelConfig.primary = overrides.model
      defaults.model = modelConfig
    }
    if (overrides.thinking) {
      defaults.thinkingDefault = overrides.thinking
    }
    if (overrides.verbose) {
      defaults.verboseDefault = overrides.verbose
    }
    agents.defaults = defaults
    config.agents = agents
  }

  if (overrides.pluginLoadPaths && overrides.pluginLoadPaths.length > 0) {
    const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {}
    const load = (plugins.load as Record<string, unknown> | undefined) ?? {}
    const existingPaths = Array.isArray(load.paths)
      ? load.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const mergedPaths = [...existingPaths]
    for (const pluginPath of overrides.pluginLoadPaths) {
      if (!mergedPaths.includes(pluginPath)) {
        mergedPaths.push(pluginPath)
      }
    }
    load.paths = mergedPaths
    plugins.load = load
    config.plugins = plugins
  }

  if (overrides.pluginAllowIds && overrides.pluginAllowIds.length > 0) {
    const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {}
    const existingAllow = Array.isArray(plugins.allow)
      ? plugins.allow.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const mergedAllow = [...existingAllow]
    for (const pluginId of overrides.pluginAllowIds) {
      if (!mergedAllow.includes(pluginId)) {
        mergedAllow.push(pluginId)
      }
    }
    plugins.allow = mergedAllow
    config.plugins = plugins
  }

  if (overrides.providerBaseUrls && Object.keys(overrides.providerBaseUrls).length > 0) {
    const models = (config.models as Record<string, unknown> | undefined) ?? {}
    const providers = (models.providers as Record<string, unknown> | undefined) ?? {}
    for (const [providerId, baseUrl] of Object.entries(overrides.providerBaseUrls)) {
      const provider = (providers[providerId] as Record<string, unknown> | undefined) ?? {}
      provider.baseUrl = baseUrl
      providers[providerId] = provider
    }
    models.providers = providers
    config.models = models
  }

  return config
}

async function writeRuntimeConfig(
  configPath: string,
  config: Record<string, unknown>,
  overrides: ConfigOverrides,
): Promise<string | undefined> {
  const updated = applyConfigOverrides(config, overrides)
  const token = getGatewayToken(updated)
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return token
}

async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function getGatewayToken(config: Record<string, unknown>): string | undefined {
  const gateway = config.gateway as Record<string, unknown> | undefined
  const auth = gateway?.auth as Record<string, unknown> | undefined
  const token = auth?.token
  return typeof token === 'string' && token.trim().length > 0 ? token : undefined
}
