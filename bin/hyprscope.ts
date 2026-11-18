#!/usr/bin/env node
import { main } from '../src/entry.ts'

process.exitCode = await main(process.argv.slice(2))
