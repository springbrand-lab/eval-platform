// Writes dist/runtime-package: a package.json and pruned lockfile holding only the bundle's external
// registry dependencies, so the runtime image installs nothing else (same approach as sp-platform's API).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

/** Optional imports guarded by try/catch (ws native accelerators, debug colors); the runtime image leaves them out. */
const OPTIONAL_EXTERNALS = new Set(["bufferutil", "utf-8-validate", "supports-color"]);

export async function writeRuntimePackage(root, app, destination) {
  const [manifest, rootManifest, metadata, lock, workspace] = await Promise.all([
    readFile(path.join(app, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(app, "dist/build-meta.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "pnpm-lock.yaml"), "utf8").then(parse),
    readFile(path.join(root, "pnpm-workspace.yaml"), "utf8").then(parse),
  ]);
  const importer = lock.importers[path.relative(root, app).split(path.sep).join("/")];
  const names = [...new Set(Object.values(metadata.outputs).flatMap((output) =>
    output.imports
      .filter(({ path: name, external }) => external && !isBuiltin(name) && !name.startsWith("."))
      .map(({ path: name }) => name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/")),
  ))].filter((name) => !OPTIONAL_EXTERNALS.has(name)).sort();
  const dependencies = {};
  const locked = {};
  for (const name of names) {
    const dependency = manifest.dependencies?.[name];
    const resolution = importer?.dependencies?.[name];
    if (!dependency || !resolution || resolution.version.startsWith("link:")) {
      throw new Error(`Runtime external ${name} must be a frozen registry production dependency`);
    }
    dependencies[name] = dependency;
    locked[name] = resolution;
  }

  const snapshots = {};
  const packages = {};
  const pending = Object.entries(locked).map(([name, resolution]) => [name, resolution.version]);
  while (pending.length) {
    const [name, version] = pending.pop();
    const key = `${name}@${version}`;
    if (snapshots[key]) continue;
    const snapshot = lock.snapshots?.[key];
    const packageKey = key.split("(")[0];
    if (!snapshot || !lock.packages?.[packageKey]) {
      throw new Error(`Missing frozen runtime dependency ${key}`);
    }
    snapshots[key] = snapshot;
    packages[packageKey] = lock.packages[packageKey];
    pending.push(...Object.entries(snapshot.dependencies ?? {}), ...Object.entries(snapshot.optionalDependencies ?? {}));
  }

  // Patches of packages outside the runtime set (e.g. Web-only editors) have no file in the runtime image.
  const runtimePatches = (patches) => patches === undefined ? undefined
    : Object.fromEntries(Object.entries(patches).filter(([key]) => packages[key] !== undefined));
  const patchedDependencies = runtimePatches(lock.patchedDependencies);
  if (patchedDependencies && Object.keys(patchedDependencies).length > 0) {
    throw new Error(`Runtime dependencies are patched (${Object.keys(patchedDependencies).join(", ")}); copy their patch files into the runtime package`);
  }
  const { patchedDependencies: _lockPatches, ...runtimeLock } = lock;
  const { patchedDependencies: _workspacePatches, ...runtimeWorkspace } = workspace;

  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(path.join(destination, "package.json"), JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: manifest.type,
      packageManager: rootManifest.packageManager,
      dependencies,
    }, null, 2) + "\n"),
    // Keep the source resolutions and integrity hashes; installation walks only these externals.
    writeFile(path.join(destination, "pnpm-lock.yaml"), stringify({ ...runtimeLock, importers: { ".": { dependencies: locked } }, packages, snapshots })),
    writeFile(path.join(destination, "pnpm-workspace.yaml"), stringify({ ...runtimeWorkspace, packages: ["."] })),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = fileURLToPath(new URL("..", import.meta.url));
  const root = path.resolve(app, "../..");
  await writeRuntimePackage(root, app, path.join(app, "dist/runtime-package"));
}
