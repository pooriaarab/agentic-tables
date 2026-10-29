#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-tables-mcp ${VERSION}
Usage: agentic-tables-mcp [mcp] [--help | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

// `agentic-tables-mcp mcp --help` answers like `agentic-tables-mcp --help`. The optional `mcp` word is skipped.
const argv = process.argv.slice(2);
const flag = argv[0] === "mcp" ? argv[1] : argv[0];
if (flag === "--version" || flag === "-V" || flag === "-v") {
  process.stdout.write(`${VERSION}\n`);
} else if (flag === "--help" || flag === "-h") {
  process.stdout.write(HELP);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./main.js")
    .then(({ main }) => main(["mcp"]))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
