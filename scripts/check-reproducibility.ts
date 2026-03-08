#!/usr/bin/env bun
/**
 * check-reproducibility.ts — Verify that the build is fully pinned for deterministic EIF output.
 *
 * Checks:
 *   1. All Containerfile FROM images use @sha256: digests (excluding scratch & internal stages)
 *   2. Cargo.lock files exist for all Rust crates
 *   3. Cargo builds use --locked flag
 *   4. bun.lock exists
 *   5. Bun install uses --frozen-lockfile
 *   6. Warns about floating versions in package.json
 *   7. Lockfiles not gitignored
 *   8. Go dependency pinning (go.sum exists)
 *   9. Go builds are static and deterministic (CGO_ENABLED=0)
 *  10. Docker build uses --provenance=false (prevents non-deterministic metadata)
 *  11. Initramfs timestamps are zeroed and cpio uses --reproducible
 *
 * Usage: bun scripts/check-reproducibility.ts
 */

import { existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONTAINERFILE = resolve(REPO_ROOT, "Containerfile");

let errors = 0;

const pass = (msg: string) => console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
const fail = (msg: string) => { console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); errors++; };
const warn = (msg: string) => console.log(`  \x1b[33mWARN\x1b[0m ${msg}`);

console.log(`Reproducibility check for: ${REPO_ROOT}\n`);

// --- 1. Containerfile: all FROM images must have @sha256: digest ---
console.log("1. Containerfile image pinning");
if (!existsSync(CONTAINERFILE)) {
  fail("Containerfile not found");
} else {
  const content = await Bun.file(CONTAINERFILE).text();
  const lines = content.split("\n");

  // Collect stage aliases (e.g., "rust-base", "build", "base")
  const stageAliases = new Set<string>();
  for (const line of lines) {
    const match = line.match(/\bAS\s+(\S+)/i);
    if (match) stageAliases.add(match[1]);
  }

  const fromLines = lines.filter(l => /^FROM\s+/.test(l));
  let unpinnedCount = 0;

  for (const line of fromLines) {
    const image = line.replace(/^FROM\s+/, "").split(/\s+/)[0];
    // Skip scratch and internal stage references
    if (image === "scratch") continue;
    if (stageAliases.has(image)) continue;

    if (!image.includes("@sha256:")) {
      fail(`Unpinned image: ${line.trim()}`);
      unpinnedCount++;
    }
  }

  if (unpinnedCount === 0) {
    const externalCount = fromLines.filter(l => {
      const img = l.replace(/^FROM\s+/, "").split(/\s+/)[0];
      return img !== "scratch" && !stageAliases.has(img);
    }).length;
    pass(`All ${externalCount} external FROM images pinned by SHA256 digest`);
  }
}
console.log();

// --- 2. Cargo.lock files ---
console.log("2. Cargo.lock files");
const cargoGlob = new Glob("**/Cargo.toml");
const cargoTomls: string[] = [];
for await (const path of cargoGlob.scan({ cwd: REPO_ROOT, absolute: true })) {
  if (!path.includes("/target/")) cargoTomls.push(path);
}

if (cargoTomls.length === 0) {
  pass("No Rust crates found (nothing to check)");
} else {
  for (const toml of cargoTomls) {
    const dir = dirname(toml);
    const crate = basename(dir);
    if (existsSync(resolve(dir, "Cargo.lock"))) {
      pass(`${crate}/Cargo.lock exists`);
    } else {
      fail(`${crate}/Cargo.lock missing — run 'cargo generate-lockfile' in ${dir}`);
    }
  }
}
console.log();

// --- 3. Cargo builds use --locked ---
console.log("3. Cargo --locked flag");
if (existsSync(CONTAINERFILE)) {
  const content = await Bun.file(CONTAINERFILE).text();
  const cargoBuilds = content.split("\n").filter(l => l.includes("cargo build"));

  if (cargoBuilds.length === 0) {
    pass("No cargo build commands in Containerfile");
  } else {
    let allLocked = true;
    for (const line of cargoBuilds) {
      if (!line.includes("--locked")) {
        fail(`Missing --locked: ${line.trim()}`);
        allLocked = false;
      }
    }
    if (allLocked) {
      pass(`All ${cargoBuilds.length} cargo build commands use --locked`);
    }
  }
}
console.log();

// --- 4. bun.lock ---
console.log("4. Bun lockfile");
if (existsSync(resolve(REPO_ROOT, "bun.lock")) || existsSync(resolve(REPO_ROOT, "bun.lockb"))) {
  pass("bun.lock exists");
} else {
  fail("bun.lock missing — run 'bun install' to generate it");
}
console.log();

// --- 5. Bun install uses --frozen-lockfile ---
console.log("5. Bun --frozen-lockfile flag");
if (existsSync(CONTAINERFILE)) {
  const content = await Bun.file(CONTAINERFILE).text();
  const bunInstalls = content.split("\n").filter(l => l.includes("bun install"));

  if (bunInstalls.length === 0) {
    pass("No bun install commands in Containerfile");
  } else {
    let hasFrozen = false;
    for (const line of bunInstalls) {
      if (line.includes("--frozen-lockfile")) {
        hasFrozen = true;
      } else if (line.includes("||")) {
        // Fallback after || is acceptable
        warn(`Fallback without --frozen-lockfile (acceptable if primary uses it): ${line.trim()}`);
      } else {
        fail(`Missing --frozen-lockfile: ${line.trim()}`);
      }
    }
    if (hasFrozen) pass("Primary bun install uses --frozen-lockfile");
  }
}
console.log();

// --- 6. package.json floating versions ---
console.log("6. package.json version pinning");
const pkgPath = resolve(REPO_ROOT, "package.json");
if (existsSync(pkgPath)) {
  const pkg = await Bun.file(pkgPath).json();
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  let hasIssues = false;

  for (const [name, version] of Object.entries(allDeps) as [string, string][]) {
    if (version === "latest" || version === "*") {
      fail(`"${name}": "${version}" — 'bun update' would silently change resolved version`);
      hasIssues = true;
    } else if (/^\^[0-9]+$/.test(version)) {
      fail(`"${name}": "${version}" — wide range, 'bun update' would silently change resolved version`);
      hasIssues = true;
    }
  }

  if (!hasIssues) {
    pass("All versions use exact or narrow ranges");
  }
} else {
  warn("No package.json found");
}
console.log();

// --- 7. Lockfiles not gitignored ---
console.log("7. Lockfiles not gitignored");
const gitignorePath = resolve(REPO_ROOT, ".gitignore");
if (existsSync(gitignorePath)) {
  const gitignore = await Bun.file(gitignorePath).text();
  const ignoredLocks = gitignore.split("\n").filter(l =>
    /^(bun\.lock|bun\.lockb|Cargo\.lock)/.test(l.trim())
  );
  if (ignoredLocks.length > 0) {
    fail(`Lockfiles are gitignored — they must be committed for reproducible builds: ${ignoredLocks.join(", ")}`);
  } else {
    pass("Lockfiles are not gitignored");
  }
} else {
  pass("No .gitignore (lockfiles will be committed)");
}
console.log();

// --- 8. Go dependency pinning ---
console.log("8. Go dependency pinning");
const goModGlob = new Glob("**/go.mod");
const goMods: string[] = [];
for await (const path of goModGlob.scan({ cwd: REPO_ROOT, absolute: true })) {
  if (!path.includes("/vendor/")) goMods.push(path);
}

if (goMods.length === 0) {
  pass("No Go modules found (nothing to check)");
} else {
  for (const mod of goMods) {
    const dir = dirname(mod);
    const modName = basename(dir);
    if (existsSync(resolve(dir, "go.sum"))) {
      pass(`${modName}/go.sum exists`);
    } else {
      fail(`${modName}/go.sum missing — run 'go mod tidy' in ${dir}`);
    }
  }
}
console.log();

// --- 9. Go builds are static (CGO_ENABLED=0) ---
console.log("9. Go static builds");
if (existsSync(CONTAINERFILE)) {
  const content = await Bun.file(CONTAINERFILE).text();
  const goBuilds = content.split("\n").filter(l => /\bgo build\b/.test(l));

  if (goBuilds.length === 0) {
    pass("No go build commands in Containerfile");
  } else {
    let allStatic = true;
    for (const line of goBuilds) {
      if (!line.includes("CGO_ENABLED=0")) {
        fail(`Go build without CGO_ENABLED=0 (not static): ${line.trim()}`);
        allStatic = false;
      }
    }
    if (allStatic) {
      pass(`All ${goBuilds.length} go build commands use CGO_ENABLED=0`);
    }
  }
}
console.log();

// --- 10. Docker --provenance=false ---
console.log("10. Docker provenance disabled");
const makefile = resolve(REPO_ROOT, "Makefile");
if (existsSync(makefile)) {
  const content = await Bun.file(makefile).text();
  if (content.includes("--provenance=false")) {
    pass("Makefile passes --provenance=false to docker build");
  } else {
    fail("Makefile missing --provenance=false — Docker may embed non-deterministic metadata");
  }
} else {
  warn("No Makefile found");
}
console.log();

// --- 11. Deterministic cpio (timestamps zeroed, --reproducible) ---
console.log("11. Deterministic initramfs");
if (existsSync(CONTAINERFILE)) {
  const content = await Bun.file(CONTAINERFILE).text();
  const checks = {
    timestamps: content.includes('touch -hcd "@0"'),
    sorted: content.includes("sort -z"),
    reproducible: content.includes("--reproducible"),
  };

  if (checks.timestamps && checks.sorted && checks.reproducible) {
    pass("cpio build zeroes timestamps, sorts entries, and uses --reproducible");
  } else {
    if (!checks.timestamps) fail("Missing timestamp zeroing (touch -hcd @0) in cpio build");
    if (!checks.sorted) fail("Missing sorted file list (sort -z) in cpio build");
    if (!checks.reproducible) fail("Missing --reproducible flag in cpio build");
  }
} else {
  warn("No Containerfile found");
}
console.log();

// --- Summary ---
console.log("---");
if (errors > 0) {
  console.log(`\x1b[31m${errors} issue(s) found that will break reproducible builds.\x1b[0m`);
  process.exit(1);
} else {
  console.log("\x1b[32mAll checks passed. Build should be reproducible.\x1b[0m");
}
