#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [nodeSourceArg, resourcesArg] = process.argv.slice(2);
if (!nodeSourceArg || !resourcesArg) {
  console.error("Usage: bundle-node-runtime.mjs <node-binary> <resources-directory>");
  process.exit(2);
}

const nodeSource = fs.realpathSync(nodeSourceArg);
const resourcesDir = path.resolve(resourcesArg);
const nodeTarget = path.join(resourcesDir, "node");
const librariesDir = path.join(resourcesDir, "lib");
const executableSourceDir = path.dirname(nodeSource);
const copiedByName = new Map();
const processedTargets = new Set();

fs.mkdirSync(librariesDir, { recursive: true });
fs.copyFileSync(nodeSource, nodeTarget);
fs.chmodSync(nodeTarget, 0o755);

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

function dependencies(binary) {
  return commandOutput("otool", ["-L", binary])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);
}

function rpaths(binary) {
  const lines = commandOutput("otool", ["-l", binary]).split("\n");
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = lines[cursor].trim().match(/^path\s+(\S+)\s+/);
      if (match) {
        result.push(match[1]);
        break;
      }
    }
  }
  return result;
}

function expandToken(value, loaderDirectory) {
  return value
    .replace(/^@loader_path/, loaderDirectory)
    .replace(/^@executable_path/, executableSourceDir);
}

function resolveDependency(dependency, binary) {
  if (dependency.startsWith("/")) return dependency;
  const loaderDirectory = path.dirname(binary);
  if (dependency.startsWith("@loader_path") || dependency.startsWith("@executable_path")) {
    return expandToken(dependency, loaderDirectory);
  }
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length);
    for (const runtimePath of rpaths(binary)) {
      const candidate = path.join(expandToken(runtimePath, loaderDirectory), suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot resolve ${dependency} required by ${binary}`);
}

function isSystemLibrary(dependency) {
  return dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/");
}

function bundle(binarySource, binaryTarget, isMainExecutable = false) {
  if (processedTargets.has(binaryTarget)) return;
  processedTargets.add(binaryTarget);

  for (const dependency of dependencies(binarySource)) {
    if (isSystemLibrary(dependency)) continue;
    const resolved = fs.realpathSync(resolveDependency(dependency, binarySource));
    const filename = path.basename(dependency);
    const previous = copiedByName.get(filename);
    if (previous && previous !== resolved) {
      throw new Error(`Conflicting runtime libraries named ${filename}: ${previous} and ${resolved}`);
    }
    copiedByName.set(filename, resolved);

    const target = path.join(librariesDir, filename);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(resolved, target);
      fs.chmodSync(target, 0o755);
    }
    bundle(resolved, target);

    const replacement = isMainExecutable
      ? `@loader_path/lib/${filename}`
      : `@loader_path/${filename}`;
    execFileSync("install_name_tool", ["-change", dependency, replacement, binaryTarget], { stdio: "ignore" });
  }

  if (!isMainExecutable) {
    execFileSync("install_name_tool", ["-id", `@loader_path/${path.basename(binaryTarget)}`, binaryTarget], {
      stdio: "ignore",
    });
  }
}

bundle(nodeSource, nodeTarget, true);
console.log(`Bundled Node.js with ${copiedByName.size} non-system runtime libraries.`);
