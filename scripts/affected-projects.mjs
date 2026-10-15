import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_NAMES = [
  "@eval-platform/eval-api",
  "@eval-platform/eval-cli",
  "@eval-platform/eval-web",
];

const OUTPUT_NAMES = new Map([
  ["@eval-platform/eval-api", "api"],
  ["@eval-platform/eval-cli", "cli"],
  ["@eval-platform/eval-web", "web"],
]);

function workspaceDirectories(root) {
  const directories = ["apps/eval-api", "apps/eval-cli", "apps/eval-web"];
  const packagesDirectory = path.join(root, "packages");
  if (!existsSync(packagesDirectory)) return directories;

  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(`packages/${entry.name}`);
  }
  return directories;
}

function workspaceGraph(root) {
  const workspaces = new Map();
  for (const directory of workspaceDirectories(root)) {
    const manifestPath = path.join(root, directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    workspaces.set(manifest.name, {
      directory,
      dependencies: new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    });
  }
  return workspaces;
}

function addAllApps(target) {
  for (const appName of APP_NAMES) target.add(appName);
}

function isRootConfigurationFile(file) {
  return (
    file === "package.json" ||
    file === "pnpm-workspace.yaml" ||
    file === "tsconfig.base.json" ||
    file === ".node-version" ||
    file === "scripts/affected-projects.mjs" ||
    file.startsWith(".github/workflows/") ||
    file.startsWith(".github/actions/")
  );
}

function affectedProjects(files, root = process.cwd()) {
  const workspaces = workspaceGraph(root);
  const changedWorkspaces = new Set();
  let workspaceManifestChanged = false;
  let lockfileChanged = false;
  let packages = false;
  let all = false;

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");

    if (isRootConfigurationFile(normalized)) {
      all = true;
      continue;
    }

    // The API's deployment files ship in its image and compose stack.
    if (normalized.startsWith("infra/aws/deploy/")) {
      changedWorkspaces.add("@eval-platform/eval-api");
      continue;
    }

    if (normalized === "pnpm-lock.yaml") {
      lockfileChanged = true;
      continue;
    }

    const workspaceEntry = [...workspaces.entries()].find(([, workspace]) =>
      normalized === workspace.directory || normalized.startsWith(`${workspace.directory}/`),
    );
    if (!workspaceEntry) continue;

    changedWorkspaces.add(workspaceEntry[0]);
    if (normalized === `${workspaceEntry[1].directory}/package.json`) workspaceManifestChanged = true;
    if (workspaceEntry[1].directory.startsWith("packages/")) packages = true;
  }

  if (lockfileChanged && !workspaceManifestChanged) all = true;

  const affectedWorkspaces = new Set(changedWorkspaces);
  if (all) {
    addAllApps(affectedWorkspaces);
    packages = true;
  } else {
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [workspaceName, workspace] of workspaces) {
        if (affectedWorkspaces.has(workspaceName)) continue;
        if (![...workspace.dependencies].some((dependency) => affectedWorkspaces.has(dependency))) continue;
        affectedWorkspaces.add(workspaceName);
        expanded = true;
      }
    }
  }

  const outputs = Object.fromEntries(
    [...OUTPUT_NAMES.entries()].map(([appName, outputName]) => [
      outputName,
      affectedWorkspaces.has(appName),
    ]),
  );
  outputs.packages = packages;
  outputs.any = Object.values(outputs).some(Boolean);
  return outputs;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function changedFiles(base, head) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
  } catch {
    return null;
  }
  return execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function printOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const forceAll = process.argv.includes("--all");
  const files = forceAll ? null : changedFiles(argument("--base"), argument("--head") ?? "HEAD");
  printOutputs(files === null ? affectedProjects(["pnpm-lock.yaml"], root) : affectedProjects(files, root));
}

export { affectedProjects };
