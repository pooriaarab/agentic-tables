#!/usr/bin/env node
import { main } from "./main.js";

main(["mcp"]).then((code) => {
  if (code !== 0) process.exit(code);
});
