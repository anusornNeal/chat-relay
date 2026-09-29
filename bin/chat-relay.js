#!/usr/bin/env node
import { runCli } from "../cli/index.mjs";

const code = await runCli(process.argv.slice(2));
if (Number.isInteger(code) && code !== 0) process.exitCode = code;
