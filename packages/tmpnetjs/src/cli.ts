#!/usr/bin/env node
// CLI dispatcher. Calls into ./commands.* once those land.

import { up, down, clean } from "./index.js";

const USAGE = `
tmpnetjs — local Avalanche network for ICM/ICTT dev

  tmpnetjs up      [--fresh]            Boot network + L1 + ICM + relayer
  tmpnetjs down    [--keep-snapshot]    Stop processes (snapshot kept by default)
  tmpnetjs clean                        Nuke data, snapshots, binaries
  tmpnetjs status                       Show running processes + artifact paths

Run with no args to see this help.
`.trim();

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "up": {
      const fresh = rest.includes("--fresh");
      void fresh; // wired up by commands.ts later
      await up();
      return 0;
    }
    case "down": {
      const keepSnapshot = !rest.includes("--no-keep-snapshot");
      await down({ keepSnapshot });
      return 0;
    }
    case "clean":
      await clean();
      return 0;
    case "status":
      console.error("status — not yet implemented");
      return 1;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
