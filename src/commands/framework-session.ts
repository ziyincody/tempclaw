import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupContainerIfExists, inspectContainerRunning } from './framework-docker.js'
import { cleanupRuntimeDirs } from './framework-runtime.js'
import type { FrameworkAdapterMap, FrameworkId, FrameworkSession } from './framework-types.js'

const SESSION_FILE_PATH = join(tmpdir(), 'tempclaw-session.json')

export async function readSession(): Promise<FrameworkSession | undefined> {
  try {
    const raw = await readFile(SESSION_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as FrameworkSession
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export async function writeSession(session: FrameworkSession): Promise<void> {
  await writeFile(SESSION_FILE_PATH, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export async function clearSession(): Promise<void> {
  await rm(SESSION_FILE_PATH, { force: true }).catch(() => undefined)
}

export async function ensureNoActiveSession(adapters: FrameworkAdapterMap): Promise<void> {
  const session = await readSession()
  if (!session) {
    return
  }

  const adapter = adapters[session.framework]
  const running = await inspectContainerRunning(session.containerName)
  if (running && await adapter.isReady(session)) {
    throw new Error(
      `A tempclaw ${adapter.displayName} sandbox is already running (${session.containerName}). Use "npm run tempclaw -- ${session.framework} down" first.`,
    )
  }

  if (running && isSessionTransitionInFlight(session)) {
    throw new Error(
      `A tempclaw ${adapter.displayName} sandbox is still ${session.lifecycleState} (${session.containerName}). Wait a moment or use "npm run tempclaw -- ${session.framework} down" if it is stuck.`,
    )
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
}

export async function requireRunningSession(
  framework: FrameworkId,
  adapters: FrameworkAdapterMap,
): Promise<FrameworkSession> {
  const expectedAdapter = adapters[framework]
  const session = await readSession()
  if (!session) {
    throw new Error(`No active tempclaw ${expectedAdapter.displayName} session. Start one with: npm run tempclaw -- ${framework} up`)
  }

  const actualAdapter = adapters[session.framework]
  if (session.framework !== framework) {
    throw new Error(
      `A tempclaw ${actualAdapter.displayName} session is active (${session.containerName}). Use "npm run tempclaw -- ${session.framework} down" first.`,
    )
  }

  const running = await inspectContainerRunning(session.containerName)
  if (!running) {
    await cleanupRuntimeDirs(session.runtimeRoot)
    await clearSession()
    throw new Error(
      `The saved tempclaw ${expectedAdapter.displayName} session is no longer running. Start a new one with: npm run tempclaw -- ${framework} up`,
    )
  }

  if (await expectedAdapter.isReady(session)) {
    const readySession = normalizeReadySession(session)
    if (readySession !== session) {
      await writeSession(readySession)
    }
    return readySession
  }

  if (isSessionTransitionInFlight(session)) {
    throw new Error(`The tempclaw ${expectedAdapter.displayName} sandbox is still ${session.lifecycleState} (${session.containerName}). Try again in a moment.`)
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
  throw new Error(
    `The saved tempclaw ${expectedAdapter.displayName} session is running without a ready runtime. It was cleaned up; start a new one with: npm run tempclaw -- ${framework} up`,
  )
}

function isSessionTransitionInFlight(session: FrameworkSession): boolean {
  if (session.lifecycleState === 'ready') {
    return false
  }

  return isHostProcessRunning(session.lifecyclePid)
}

function normalizeReadySession(session: FrameworkSession): FrameworkSession {
  if (session.lifecycleState === 'ready' && session.lifecyclePid === undefined) {
    return session
  }

  return {
    ...session,
    lifecycleState: 'ready',
    lifecyclePid: undefined,
  }
}

function isHostProcessRunning(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
