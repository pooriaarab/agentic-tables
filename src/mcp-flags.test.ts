import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

// Ways `mcp --help` can fail: it exits 2 on an unknown flag, or it starts the server and waits on stdin.
// Each case runs the built bin with stdin left open and a bare environment (no principal).

const dist = (file: string) => join(process.cwd(), "dist", file);

function run(file: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist(file), ...args], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("help and version never start the server", () => {
  const cases: [string, string[], "help" | "version"][] = [];
  for (const file of ["cli.js", "mcp-bin.js"]) {
    const prefixes = file === "cli.js" ? [[], ["mcp"]] : [[]];
    for (const prefix of prefixes) {
      for (const f of ["--help", "-h"]) cases.push([file, [...prefix, f], "help"]);
      for (const f of ["--version", "-V", "-v"]) cases.push([file, [...prefix, f], "version"]);
    }
  }
  for (const [file, args, kind] of cases) {
    test(`${file} ${args.join(" ")} exits 0 within 5 s`, async () => {
      const r = await run(file, args);
      expect([r.code, r.err]).toEqual([0, ""]);
      if (kind === "version") expect(r.out.trim()).toBe(VERSION);
      else expect(r.out).toContain("Usage");
    });
  }
});
