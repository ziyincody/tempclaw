import { readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  if (running) {
    throw new Error(
      `A tempclaw OpenClaw sandbox is already running (${session.containerName}). Use "npm run tempclaw -- openclaw down" first.`,
    )
  }

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

  return session
}

async function inspectContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', containerName])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}
