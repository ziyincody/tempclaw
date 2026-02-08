import { readFile, writeFile } from 'node:fs/promises'

type ConfigOverrides = {
  token?: string
  model?: string
  thinking?: string
  verbose?: string
}

export async function writeRuntimeConfigFromTemplate(
  configPath: string,
  templatePath: string,
  overrides: ConfigOverrides,
): Promise<string | undefined> {
  const template = await readFile(templatePath, 'utf8')
  const parsed = JSON.parse(template) as Record<string, unknown>
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const updated = applyConfigOverrides(config, overrides)
  const token = getGatewayToken(updated)
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return token
}

export async function writeRuntimeConfigFromPath(
  configPath: string,
  sourcePath: string,
  overrides: ConfigOverrides,
): Promise<string | undefined> {
  const raw = await readFile(sourcePath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const updated = applyConfigOverrides(config, overrides)
  const token = getGatewayToken(updated)
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return token
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
  if (overrides.token) {
    const gateway = (config.gateway as Record<string, unknown> | undefined) ?? {}
    const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {}
    auth.mode = 'token'
    auth.token = overrides.token
    gateway.mode = 'local'
    gateway.auth = auth
    config.gateway = gateway
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

  return config
}

function getGatewayToken(config: Record<string, unknown>): string | undefined {
  const gateway = config.gateway as Record<string, unknown> | undefined
  const auth = gateway?.auth as Record<string, unknown> | undefined
  const token = auth?.token
  return typeof token === 'string' && token.trim().length > 0 ? token : undefined
}
