#!/usr/bin/env bun
import { runSkillpackCli } from "./index.js";

const code = await runSkillpackCli(process.argv.slice(2), process);
process.exit(code);
