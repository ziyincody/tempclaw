import { readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cleanupContainerIfExists, isGatewayReady } from './openclaw-docker.js'
import { cleanupRuntimeDirs } from './openclaw-runtime.js'
import type { OpenClawSession } from './openclaw-types.js'

const execFileAsync = promisify(execFile)
const SESSION_FILE_PATH = join(tmpdir(), 'tempclaw-openclaw-session.json')

export async function readSession(): Promise<OpenClawSession | undefined> {
  try {
    const raw = await readFile(SESSION_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as OpenClawSession
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export async function writeSession(session: OpenClawSession): Promise<void> {
  await writeFile(SESSION_FILE_PATH, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export async function clearSession(): Promise<void> {
  await rm(SESSION_FILE_PATH, { force: true }).catch(() => undefined)
}

export async function ensureNoActiveSession(): Promise<void> {
  const session = await readSession()
  if (!session) return

  const running = await inspectContainerRunning(session.containerName)
  if (running && await isGatewayReady(session.containerName)) {
    throw new Error(
      `A tempclaw OpenClaw sandbox is already running (${session.containerName}). Use "npm run tempclaw -- openclaw down" first.`,
    )
  }

  if (running && isSessionTransitionInFlight(session)) {
    throw new Error(
      `A tempclaw OpenClaw sandbox is still ${session.lifecycleState} (${session.containerName}). Wait a moment or use "npm run tempclaw -- openclaw down" if it is stuck.`,
    )
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
}

export async function requireRunningSession(): Promise<OpenClawSession> {
  const session = await readSession()
  if (!session) {
    throw new Error('No active tempclaw OpenClaw session. Start one with: npm run tempclaw -- openclaw up')
  }

  const running = await inspectContainerRunning(session.containerName)
  if (!running) {
    await cleanupRuntimeDirs(session.runtimeRoot)
    await clearSession()
    throw new Error('The saved tempclaw OpenClaw session is no longer running. Start a new one with: npm run tempclaw -- openclaw up')
  }

  if (await isGatewayReady(session.containerName)) {
    const readySession = normalizeReadySession(session)
    if (readySession !== session) {
      await writeSession(readySession)
    }
    return readySession
  }

  if (isSessionTransitionInFlight(session)) {
    throw new Error(`The tempclaw OpenClaw sandbox is still ${session.lifecycleState} (${session.containerName}). Try again in a moment.`)
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
  throw new Error('The saved tempclaw OpenClaw session is running without a ready gateway. It was cleaned up; start a new one with: npm run tempclaw -- openclaw up')
}

async function inspectContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', containerName])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

function isSessionTransitionInFlight(session: OpenClawSession): boolean {
  if (session.lifecycleState === 'ready') {
    return false
  }

  return isHostProcessRunning(session.lifecyclePid)
}

function normalizeReadySession(session: OpenClawSession): OpenClawSession {
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
