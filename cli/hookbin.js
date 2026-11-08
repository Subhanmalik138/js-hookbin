#!/usr/bin/env node
import { run } from "../src/cli.js";

const result = await run(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.code);
