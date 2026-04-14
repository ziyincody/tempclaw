import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ContainerMount, RuntimeDirs } from './framework-types.js'

export async function cleanupRuntimeDirs(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

export async function ensureExists(path: string, message: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(message)
  }
}

export async function createRuntimeDirs(prefix: string): Promise<RuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const stateDir = join(root, 'state')
  const workspaceDir = join(root, 'workspace')
  await mkdir(stateDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  return { root, stateDir, workspaceDir }
}

export function parseMountPaths(raw?: string): ContainerMount[] {
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

      return { hostPath, containerPath, readOnly: true }
    })
}

export function parseContainerEnv(raw?: string): Record<string, string> | undefined {
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
      throw new Error(`Invalid environment variable "${assignment}". Use name=value.`)
    }

    const key = assignment.slice(0, separatorIndex).trim()
    const value = assignment.slice(separatorIndex + 1).trim()
    if (!key || !value) {
      throw new Error(`Invalid environment variable "${assignment}". Use name=value.`)
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name "${key}".`)
    }

    parsed[key] = value
  }

  return parsed
}
