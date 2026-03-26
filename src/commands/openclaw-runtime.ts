import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  writeExecApprovals,
  writeRuntimeConfigFromPath,
  writeRuntimeConfigFromTemplate,
} from '../openclaw/config.js'
import { ensureDockerAvailable, runDockerBuild } from './openclaw-docker.js'
import type { MountPath, OpenClawArgs, PluginMount, PreparedRuntime, RuntimeDirs } from './openclaw-types.js'

export async function prepareRuntime(args: OpenClawArgs): Promise<PreparedRuntime> {
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

export async function cleanupRuntimeDirs(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
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

async function createRuntimeDirs(): Promise<RuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), 'tempclaw-openclaw-'))
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
