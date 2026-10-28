#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then((code) => {
  // On zero, fall off the end so a running server (mcp) keeps its stdio open.
  if (code !== 0) process.exit(code);
});
