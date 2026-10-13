import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Active (non-historical) repository areas that must not depend on Sports2020 (FR-016/017, SC-006). */
const ACTIVE = [
  "apps",
  "packages",
  "scripts",
  "docker",
  "openedge",
  "deploy",
  "examples",
  "docs",
  ".env.example",
  "README.md",
  "QUICKSTART.md",
  "package.json",
  "playwright.config.ts",
  "playwright.licensed.config.ts"
];
/** Historical records and the one-time migration that names what it removes. */
const EXEMPT = [
  "scripts/openedge/migrate-sports2020.mjs",
  "docs/openedge-validation.md",
  "docs/validation/"
];
const PATTERN = /sports2020|-db sports\b|"sports"|sports\.db|sports\.b[i0-9]/i;

describe("no Sports2020 dependency in active files", () => {
  it("finds no Sports2020 requirement or sports database default", () => {
    const tracked = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...ACTIVE],
      {
        encoding: "utf8"
      }
    )
      .split("\n")
      .filter(Boolean)
      .filter((file) => !EXEMPT.some((exempt) => file === exempt || file.startsWith(exempt)))
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    const offenders: string[] = [];
    for (const file of tracked) {
      if (/\.(png|jpg|zip|gz|r)$/i.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        // The one-time migration command is named after what it removes.
        if (PATTERN.test(line.replaceAll("migrate-sports2020", "")))
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  it("keeps the migration exemption to the one-time removal script", () => {
    const migration = fs.readFileSync(
      path.resolve("scripts/openedge/migrate-sports2020.mjs"),
      "utf8"
    );
    assert.match(migration, /runs\/, artifacts\/ and the SQLite store/);
  });
});
