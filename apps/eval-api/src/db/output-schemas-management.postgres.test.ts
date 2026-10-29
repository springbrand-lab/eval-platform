import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "../agent-imports/model.js";
import { createPostgresManagementStore } from "../eval-management/store.js";
import { createTestDatabase } from "./test-database.js";
import { createOutputSchemaCatalog } from "./output-schemas.js";

const connection = process.env.DATABASE_URL;
const content = JSON.stringify({ type: "object", properties: { score: { type: "number" } } });

describe.skipIf(!connection)("durable management Schema identity and unchanged HTTP catalog names", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("preserves duplicate exact and case-variant names on ordinary catalog HTTP create and PATCH", async () => {
    const catalog = createOutputSchemaCatalog(database.db, "catalog-owner");
    const first = await catalog.create({ name: "Score", description: "First", content });
    const second = await catalog.create({ name: "Score", description: "Second", content });
    const third = await catalog.create({ name: "sCoRe", description: "Case variant", content });
    const fourth = await catalog.create({ name: "Other", description: "Renamable", content });
    const renamed = await catalog.updateMetadata(fourth.outputSchemaId, { name: "Score" });
    expect(renamed.name).toBe("Score");
    expect(new Set([first.outputSchemaId, second.outputSchemaId, third.outputSchemaId, renamed.outputSchemaId]).size).toBe(4);
    expect((await catalog.list()).map(({ name }) => name).sort()).toEqual(["Score", "Score", "Score", "sCoRe"]);
    expect((await createOutputSchemaCatalog(database.db, "other-owner").create({
      name: "Score", description: "Other owner", content,
    })).name).toBe("Score");
  });

  it("allows concurrent different operation keys with the same name, but not a changed intent under one key", async () => {
    const owner = "management-owner";
    const first = createPostgresManagementStore(database.db);
    const second = createPostgresManagementStore(database.db);
    const catalog = createOutputSchemaCatalog(database.db, owner);
    const plan = { version: 1, outputSchemaId: crypto.randomUUID(), name: "Feishu result",
      description: "Result", contentSha256: createHash("sha256").update(content).digest("hex") };
    const sibling = { ...plan, outputSchemaId: crypto.randomUUID() };
    const fingerprint = (key: string) => digest(["management-output-schema/v1", owner, key,
      plan.name, plan.description, plan.contentSha256]);
    const [opened, openedSibling] = await Promise.all([
      first.begin(owner, "key-1", "output_schema", fingerprint("key-1"), plan),
      second.begin(owner, "key-2", "output_schema", fingerprint("key-2"), sibling),
    ]);
    expect(opened.skillName).toBeNull();
    expect(openedSibling.skillName).toBeNull();
    expect(opened.plan).toEqual(plan);
    expect(openedSibling.plan).toEqual(sibling);
    await expect(second.begin(owner, "key-1", "output_schema", digest("changed intent"), plan))
      .rejects.toMatchObject({ code: "EVAL_SP_CONFLICT" });
    expect(await first.attempt(owner, "key-1", "output_schema")).toEqual({ status: "started" });
    // An unconfirmed write is fenced only for its original operation key.
    expect(await second.attempt(owner, "key-1", "output_schema")).toEqual({ status: "attempted" });
    expect(await catalog.get(plan.outputSchemaId)).toBeNull();
    expect(await second.attempt(owner, "key-2", "output_schema")).toEqual({ status: "started" });
    const [created, createdSibling] = await Promise.all([
      catalog.create({ name: plan.name, description: plan.description, content }, plan.outputSchemaId),
      catalog.create({ name: plan.name, description: plan.description, content }, sibling.outputSchemaId),
    ]);
    expect(created.outputSchemaId).not.toBe(createdSibling.outputSchemaId);
    for (const [key, row] of [["key-1", created], ["key-2", createdSibling]] as const) {
      const receipt = { outputSchemaId: row.outputSchemaId, name: row.name };
      await first.confirm(owner, key, "output_schema", receipt);
      await second.complete(owner, key);
      expect(await first.get(owner, key)).toMatchObject({ kind: "output_schema", status: "completed",
        stages: { output_schema: { status: "confirmed", receipt } } });
      expect(await catalog.get(row.outputSchemaId)).toMatchObject({ outputSchemaId: row.outputSchemaId, name: plan.name });
    }
  });
});
