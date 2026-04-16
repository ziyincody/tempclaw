import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensureDockerAvailable, runDockerBuild } from './framework-docker.js'
import { createRuntimeDirs, ensureExists, parseContainerEnv, parseMountPaths } from './framework-runtime.js'
import type { HermesArgs, PreparedFrameworkRuntime } from './framework-types.js'

export async function prepareHermesRuntime(args: HermesArgs): Promise<PreparedFrameworkRuntime> {
  const shouldBuild = !args.skipBuild
  const hermesPath = resolve(args.hermesPath ?? '../hermes-agent')
  const dockerfilePath = resolve(hermesPath, 'Dockerfile')
  const resolvedConfigPath = args.configPath ? resolve(args.configPath) : undefined
  const extraMounts = parseMountPaths(args.mountPath)
  const extraEnv = parseContainerEnv(args.env) ?? {}

  if (shouldBuild) {
    await ensureExists(hermesPath, `Hermes path not found: ${hermesPath}`)
    await ensureExists(dockerfilePath, `Hermes Dockerfile not found: ${dockerfilePath}`)
  }

  await ensureDockerAvailable()
  if (resolvedConfigPath) {
    await ensureExists(resolvedConfigPath, `Hermes config not found: ${resolvedConfigPath}`)
  }
  for (const mount of extraMounts) {
    await ensureExists(mount.hostPath, `Mount path not found: ${mount.hostPath}`)
  }

  if (shouldBuild) {
    await runDockerBuild({ image: args.image ?? 'hermes-agent:local', dockerfilePath, contextDir: hermesPath })
  }

  const runtime = await createRuntimeDirs('tempclaw-hermes-')
  const configPath = join(runtime.stateDir, 'config.yaml')

  if (resolvedConfigPath) {
    await copyFile(resolvedConfigPath, configPath)
  }

  return {
    image: args.image ?? 'hermes-agent:local',
    runtime,
    stateContainerPath: '/opt/data',
    workspaceContainerPath: '/workspace',
    homeDir: '/opt/data/home',
    workdir: '/workspace',
    logPath: '/opt/data/logs/agent.log',
    mounts: extraMounts,
    env: {
      HERMES_HOME: '/opt/data',
      HOME: '/opt/data/home',
      TERM: 'xterm-256color',
      ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
      ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
      ...extraEnv,
    },
    configPath,
    entrypoint: 'bash',
    command: getHermesKeepaliveCommand(),
    extraMounts,
    managedProcess: args.startGateway ? 'gateway' : undefined,
  }
}

export function getHermesLogPath(component: string | undefined): string {
  switch ((component ?? 'agent').trim().toLowerCase()) {
    case 'agent':
      return '/opt/data/logs/agent.log'
    case 'gateway':
      return '/opt/data/logs/gateway.log'
    case 'errors':
      return '/opt/data/logs/errors.log'
    default:
      throw new Error('Invalid Hermes log component. Use one of: agent, gateway, errors.')
  }
}

export function getHermesBootstrapCommand(): string {
  return [
    'set -euo pipefail',
    'mkdir -p /opt/data/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home}',
    'if [ ! -f /opt/data/.env ]; then cp /opt/hermes/.env.example /opt/data/.env; fi',
    'if [ ! -f /opt/data/config.yaml ]; then cp /opt/hermes/cli-config.yaml.example /opt/data/config.yaml; fi',
    'if [ ! -f /opt/data/SOUL.md ]; then cp /opt/hermes/docker/SOUL.md /opt/data/SOUL.md; fi',
    'if [ -d /opt/hermes/skills ]; then /opt/hermes/.venv/bin/python /opt/hermes/tools/skills_sync.py >/dev/null 2>&1 || true; fi',
  ].join('\n')
}

export function getHermesKeepaliveCommand(): string[] {
  return ['-lc', 'trap "exit 0" TERM INT; while true; do sleep 3600; done']
}

export function getHermesGatewayCommand(): string {
  return [
    'set -euo pipefail',
    'cd /workspace',
    'export HERMES_HOME=/opt/data',
    'export HOME=/opt/data/home',
    '/opt/hermes/.venv/bin/hermes gateway run --replace >> /opt/data/logs/gateway.log 2>&1',
  ].join('\n')
}

export function getHermesGatewayStopCommand(): string {
  return [
    'set -euo pipefail',
    'python=/opt/hermes/.venv/bin/python',
    '$python - <<\'PY\'',
    'from gateway.status import get_running_pid, terminate_pid',
    'pid = get_running_pid()',
    'if pid is not None:',
    '    terminate_pid(pid, force=False)',
    'PY',
  ].join('\n')
}

export function getHermesGatewayReadyCommand(): string {
  return [
    '/opt/hermes/.venv/bin/python - <<\'PY\'',
    'from gateway.status import get_running_pid, read_runtime_status',
    'import sys',
    'pid = get_running_pid()',
    'status = read_runtime_status() or {}',
    'state = status.get("gateway_state")',
    'sys.exit(0 if pid and state not in ("starting", "startup_failed") else 1)',
    'PY',
  ].join('\n')
}

export function getHermesBootstrapReadyCommand(): string {
  return 'test -f /opt/data/config.yaml -a -f /opt/data/SOUL.md -a -d /opt/data/logs -a -d /opt/data/home'
}
