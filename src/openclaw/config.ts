import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

type ConfigOverrides = {
  token?: string
  model?: string
}

export async function writeRuntimeConfigFromTemplate(
  configPath: string,
  templatePath: string,
  overrides: ConfigOverrides,
): Promise<void> {
  const template = await readFile(templatePath, 'utf8')
  const parsed = JSON.parse(template) as Record<string, unknown>
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const updated = applyConfigOverrides(config, overrides)
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
}

export async function writeRuntimeConfigFromHost(
  configPath: string,
  overrides: ConfigOverrides,
): Promise<void> {
  const source = resolve(homedir(), '.openclaw', 'openclaw.json')
  const raw = await readFile(source, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const updated = applyConfigOverrides(config, overrides)
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
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

  if (overrides.model) {
    const agents = (config.agents as Record<string, unknown> | undefined) ?? {}
    const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {}
    const modelConfig = (defaults.model as Record<string, unknown> | undefined) ?? {}
    modelConfig.primary = overrides.model
    defaults.model = modelConfig
    agents.defaults = defaults
    config.agents = agents
  }

  return config
}
