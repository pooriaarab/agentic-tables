#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-tables-mcp ${VERSION}
Usage: agentic-tables-mcp [--help | --version]

Runs the MCP server on stdio. An MCP client starts it; it takes no other arguments.
`;

const flag = process.argv[2];
if (flag === "--version" || flag === "-V") {
  console.log(VERSION);
} else if (flag === "--help" || flag === "-h") {
  console.log(HELP);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./main.js").then(({ main }) =>
    main(["mcp"]).then((code) => {
      if (code !== 0) process.exit(code);
    }),
  );
}
