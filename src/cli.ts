#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'tempclaw',
    version: '0.1.0',
    description: 'Persistent agent sandbox runner for Docker',
  },
  subCommands: {
    openclaw: () => import('./commands/openclaw.js').then((m) => m.default),
    hermes: () => import('./commands/hermes.js').then((m) => m.default),
  },
})

runMain(main)
