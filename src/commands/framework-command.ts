import { defineCommand } from 'citty'
import { randomBytes } from 'node:crypto'
import { cleanupContainerIfExists, createDetachedContainer, runContainerCommand } from './framework-docker.js'
import { buildFrameworkSession, frameworkAdapters, UnmanagedRuntimeError } from './framework-adapters.js'
import { cleanupRuntimeDirs } from './framework-runtime.js'
import { clearSession, ensureNoActiveSession, readSession, requireRunningSession, writeSession } from './framework-session.js'
import type {
  FrameworkAdapter,
  FrameworkSession,
  LogsArgs,
} from './framework-types.js'

type LogsArgShape = LogsArgs & Record<string, unknown>

export function defineFrameworkCommand<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
) {
  const lifecycleSubcommands = new Set(['up', 'tui', 'exec', 'logs', 'restart', 'down'])

  return defineCommand({
    meta: {
      name: adapter.id,
      description: adapter.description,
    },
    args: adapter.args,
    subCommands: {
      up: defineCommand({
        meta: { name: 'up', description: `Start a persistent ${adapter.displayName} sandbox container` },
        args: adapter.args,
        async run({ args }) {
          await runOrExit(() => runPersistentUp(adapter, args as unknown as TArgs))
        },
      }),
      tui: defineCommand({
        meta: { name: 'tui', description: `Attach to the running ${adapter.displayName} sandbox` },
        async run() {
          await runOrExit(() => runPersistentTui(adapter))
        },
      }),
      exec: defineCommand({
        meta: { name: 'exec', description: 'Run a command inside the running sandbox container' },
        async run() {
          await runOrExit(() => runPersistentExec(adapter))
        },
      }),
      logs: defineCommand({
        meta: { name: 'logs', description: `View ${adapter.displayName} logs from the running sandbox` },
        args: adapter.logsArgs,
        async run({ args }) {
          await runOrExit(() => runPersistentLogs(adapter, args as unknown as TLogsArgs))
        },
      }),
      restart: defineCommand({
        meta: { name: 'restart', description: `Restart the managed ${adapter.displayName} gateway inside the running sandbox` },
        async run() {
          await runOrExit(() => runPersistentRestart(adapter))
        },
      }),
      down: defineCommand({
        meta: { name: 'down', description: 'Stop the running sandbox and remove temp state' },
        async run() {
          await runOrExit(() => runPersistentDown(adapter))
        },
      }),
    },
    async run({ args }) {
      if (isLifecycleSubcommandInvocation(adapter.id, lifecycleSubcommands)) {
        return
      }
      void args
      throw new Error(`Missing subcommand. Use one of: ${Array.from(lifecycleSubcommands).join(', ')}.`)
    },
  })
}

async function runPersistentUp<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
  args: TArgs,
): Promise<void> {
  await ensureNoActiveSession(frameworkAdapters)
  const prepared = await adapter.prepareRuntime(args)
  const containerName = `tempclaw-${adapter.id}-${randomBytes(4).toString('hex')}`
  const session = buildFrameworkSession(adapter.id, containerName, prepared)

  try {
    await createDetachedContainer({
      image: prepared.image,
      runtime: prepared.runtime,
      stateContainerPath: prepared.stateContainerPath,
      workspaceContainerPath: prepared.workspaceContainerPath,
      mounts: prepared.mounts,
      env: prepared.env,
      entrypoint: prepared.entrypoint,
      command: prepared.command,
      containerName,
    })
    await adapter.start(session, prepared)
    await writeSession(session)
    await adapter.waitForReady(session)
    const readySession = markSessionReady(session)
    await writeSession(readySession)
    adapter.printSessionReady(readySession)
  } catch (error) {
    if (await canRecoverUsableSession(session, adapter)) {
      console.warn(
        `tempclaw recovered the running sandbox after a partial startup failure: ${error instanceof Error ? error.message : String(error)}`,
      )
      adapter.printSessionReady(markSessionReady(session))
      return
    }

    await cleanupContainerIfExists(containerName)
    await cleanupRuntimeDirs(prepared.runtime.root)
    await clearSessionIfOwned(containerName)
    throw error
  }
}

async function runPersistentTui<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
): Promise<void> {
  const session = await requireRunningSession(adapter.id, frameworkAdapters)
  await adapter.attachTui(session)
}

async function runPersistentExec<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
): Promise<void> {
  const session = await requireRunningSession(adapter.id, frameworkAdapters)
  const command = extractExecCommand(adapter.id)
  if (command.length === 0) {
    throw new Error(`Missing command. Use: tempclaw ${adapter.id} exec -- <command...>`)
  }

  const code = await runContainerCommand(session.containerName, command, {
    interactive: process.stdin.isTTY && process.stdout.isTTY,
  })
  if (code !== 0) {
    throw new Error(`docker exec failed (exit ${code})`)
  }
}

async function runPersistentLogs<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
  args: TLogsArgs,
): Promise<void> {
  const session = await requireRunningSession(adapter.id, frameworkAdapters)
  await adapter.runLogs(session, args)
}

async function runPersistentRestart<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
): Promise<void> {
  const session = await requireRunningSession(adapter.id, frameworkAdapters)
  const restartingSession = {
    ...session,
    lifecycleState: 'restarting' as const,
    lifecyclePid: process.pid,
  }
  await writeSession(restartingSession)

  try {
    await adapter.restart(restartingSession)
    await adapter.waitForReady(restartingSession)
    await writeSession(markSessionReady(restartingSession))
  } catch (error) {
    if (error instanceof UnmanagedRuntimeError) {
      await writeSession(markSessionReady(restartingSession))
      throw error
    }
    if (await canRecoverUsableSession(restartingSession, adapter)) {
      console.warn(
        `tempclaw recovered the running sandbox after a partial restart failure: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    throw error
  }

  console.log(`Restarted ${adapter.displayName} runtime in ${session.containerName}`)
}

async function runPersistentDown<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
): Promise<void> {
  const session = await readSession()
  if (!session) {
    console.log(`No active tempclaw ${adapter.displayName} session.`)
    return
  }

  if (session.framework !== adapter.id) {
    console.log(`A tempclaw ${frameworkAdapters[session.framework].displayName} session is active (${session.containerName}).`)
    return
  }

  await cleanupContainerIfExists(session.containerName)
  await cleanupRuntimeDirs(session.runtimeRoot)
  await clearSession()
  console.log(`Removed sandbox ${session.containerName}`)
}

function isLifecycleSubcommandInvocation(commandName: string, lifecycleSubcommands: Set<string>): boolean {
  const argv = process.argv.slice(2)
  const commandIndex = argv.indexOf(commandName)
  if (commandIndex === -1) {
    return false
  }
  const next = argv[commandIndex + 1]
  return typeof next === 'string' && lifecycleSubcommands.has(next)
}

function extractExecCommand(commandName: string): string[] {
  const execIndex = process.argv.findIndex((value, index, values) => (
    value === 'exec' && values[index - 1] === commandName
  ))
  if (execIndex === -1) {
    return []
  }

  const separatorIndex = process.argv.indexOf('--', execIndex)
  if (separatorIndex !== -1) {
    return process.argv.slice(separatorIndex + 1)
  }

  return process.argv.slice(execIndex + 1)
}

async function runOrExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function canRecoverUsableSession<TArgs extends Record<string, unknown>, TLogsArgs extends LogsArgShape>(
  session: FrameworkSession,
  adapter: FrameworkAdapter<TArgs, TLogsArgs>,
): Promise<boolean> {
  try {
    await writeSession(session)
    if (!await adapter.isReady(session, 3_000, 250)) {
      return false
    }
    await writeSession(markSessionReady(session))
    return true
  } catch {
    return false
  }
}

function markSessionReady(session: FrameworkSession): FrameworkSession {
  return {
    ...session,
    lifecycleState: 'ready',
    lifecyclePid: undefined,
  }
}

async function clearSessionIfOwned(containerName: string): Promise<void> {
  const session = await readSession()
  if (session?.containerName === containerName) {
    await clearSession()
  }
}
