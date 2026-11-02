#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const root = process.env.SETUP_FIXTURE_ROOT;
const control = path.join(root, "control");
const read = (name, fallback = "") => {
  try {
    return fs.readFileSync(path.join(control, name), "utf8");
  } catch {
    return fallback;
  }
};
const write = (name, value) => fs.writeFileSync(path.join(control, name), String(value));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(root, "events.jsonl"),
  JSON.stringify({ command, args, cwd: process.cwd(), at: Date.now() }) + "\n"
);
if (command === "proserve") {
  fs.rmSync(path.join(control, "stop"), { force: true });
  write("busy", 64);
  const child = cp.spawn(process.execPath, [path.join(__dirname, "broker.cjs")], {
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  write("broker.pid", child.pid);
  child.unref();
} else if (command === "mpro") process.exit(0);
else if (command === "pgrep") process.exit(read("busy", "0") === "0" ? 1 : 0);
else if (command === "proshut") write("stop", "1");
else if (command === "proutil" && args.includes("busy")) process.exit(Number(read("busy", "0")));
else {
  const count = Number(read("utility-count", "0")) + 1;
  write("utility-count", count);
  const transcript = fs.readFileSync(0, "utf8");
  fs.appendFileSync(path.join(root, "stdin.jsonl"), JSON.stringify({ args, transcript }) + "\n");
  const failure = Number(read("failure", "0")) || (Number(read("fail-at", "0")) === count ? 7 : 0);
  process.stdout.write("fixture utility output\n");
  if (failure) process.stderr.write("fixture native failure\n");
  process.exit(failure);
}
