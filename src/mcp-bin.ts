#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-tables-mcp ${VERSION}
Usage: agentic-tables-mcp [--help | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

const flag = process.argv[2];
if (flag === "--version" || flag === "-V") {
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
