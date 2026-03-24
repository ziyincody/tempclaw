#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'tempclaw',
    version: '0.1.0',
    description: 'Persistent OpenClaw sandbox runner for Docker',
  },
  subCommands: {
    openclaw: () => import('./commands/openclaw.js').then((m) => m.default),
  },
})

runMain(main)
