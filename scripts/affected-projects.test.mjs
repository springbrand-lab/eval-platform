import assert from "node:assert/strict";
import test from "node:test";
import { affectedProjects } from "./affected-projects.mjs";

test("keeps an app-local change isolated", () => {
  assert.deepEqual(affectedProjects(["apps/eval-web/src/index.ts"]), {
    api: false,
    cli: false,
    web: true,
    packages: false,
    any: true,
  });
});

test("includes workspace dependents", () => {
  assert.deepEqual(affectedProjects(["packages/eval-contracts/src/model.ts"]), {
    api: true,
    cli: true,
    web: true,
    packages: true,
    any: true,
  });
});

test("runs everything for shared root configuration", () => {
  assert.deepEqual(affectedProjects(["pnpm-lock.yaml"]), {
    api: true,
    cli: true,
    web: true,
    packages: true,
    any: true,
  });
});

test("keeps a workspace dependency update isolated when its manifest changed", () => {
  assert.deepEqual(affectedProjects(["pnpm-lock.yaml", "apps/eval-cli/package.json"]), {
    api: false,
    cli: true,
    web: false,
    packages: false,
    any: true,
  });
});

test("runs everything when affected-project detection changes", () => {
  assert.deepEqual(affectedProjects(["scripts/affected-projects.mjs"]), {
    api: true,
    cli: true,
    web: true,
    packages: true,
    any: true,
  });
});

test("runs everything when a CI action changes", () => {
  assert.deepEqual(affectedProjects([".github/actions/prepare-workspace/action.yml"]), {
    api: true,
    cli: true,
    web: true,
    packages: true,
    any: true,
  });
});

test("ignores documentation-only changes", () => {
  assert.deepEqual(affectedProjects(["README.md"]), {
    api: false,
    cli: false,
    web: false,
    packages: false,
    any: false,
  });
});
