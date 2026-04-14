import { defineFrameworkCommand } from './framework-command.js'
import { hermesAdapter } from './framework-adapters.js'

export default defineFrameworkCommand(hermesAdapter)
