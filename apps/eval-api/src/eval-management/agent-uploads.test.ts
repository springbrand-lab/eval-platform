import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";
import { OWNER, setupManagement, toolValue } from "./test-fixture.js";

async function skillZip(name: string) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add("SKILL.md", new Uint8ArrayReader(new TextEncoder().encode(
    `---\nname: ${name}\ndescription: Narrow skill\n---\nUse this skill.\n`,
  )));
  return zip.close();
}

describe("safe Agent library file operations", () => {
  it("does not permit Skill POST without explicit possible-overwrite approval and an exact existing ID", async () => {
    const app = setupManagement();
    const uploadRef = app.managed.addUpload("skill", "skill.zip", await skillZip("known-skill"));
    const existing = { id: "skill-1", name: "known-skill", origin: "upload", available: true, deleted: false };
    const posts = vi.fn(async () => ({ id: existing.id, name: existing.name }));
    app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
      const route = request.route as { path: string; method: string };
      if (route.path === "/skills") {
        if (route.method === "post") return posts();
        return { data: [existing], total: 1 };
      }
      throw new Error("Unexpected SP library call");
    });
    for (const fields of [{}, { overwriteExistingSkill: true },
      { overwriteExistingSkill: true, existingSkillId: "some-other-skill" }]) {
      const response = await (await app.call("upload_agent_skill", {
        operationKey: "skill-approval", uploadRef, name: "known-skill", ...fields,
      })).json();
      expect(response).toMatchObject({ result: { isError: true } });
    }
    expect(posts).not.toHaveBeenCalled();
    expect(await toolValue(await app.call("upload_agent_skill", {
      operationKey: "skill-approval", uploadRef, name: "known-skill",
      overwriteExistingSkill: true, existingSkillId: "skill-1",
    }))).toEqual({ skillId: "skill-1", name: "known-skill" });
    expect(posts).toHaveBeenCalledTimes(1);
    const duplicate = await (await app.call("upload_agent_skill", {
      operationKey: "another-operation", uploadRef, name: "known-skill",
      overwriteExistingSkill: true, existingSkillId: "skill-1",
    })).json();
    expect(duplicate).toMatchObject({ result: { isError: true } });
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("never repeats a Skill overwrite after the SP result is unknown or releases a same-name fence", async () => {
    const app = setupManagement();
    const uploadRef = app.managed.addUpload("skill", "skill.zip", await skillZip("fenced-skill"));
    const posts = vi.fn(async () => { throw new Error("SP response lost with private credentials"); });
    app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
      const route = request.route as { path: string; method: string };
      if (route.path === "/skills" && route.method === "post") return posts();
      if (route.path === "/skills") return { data: [], total: 0 };
      throw new Error("Unexpected SP library call");
    });
    const input = { operationKey: "skill-unknown", uploadRef, name: "fenced-skill", overwriteExistingSkill: true };
    for (let index = 0; index < 2; index++) {
      const response = await (await app.call("upload_agent_skill", input)).json() as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]!.text).not.toContain("private credentials");
    }
    expect(posts).toHaveBeenCalledTimes(1);
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ kind: "skill", status: "outcome_unknown", stages: { skill: "attempted" } });
    const other = await (await app.call("upload_agent_skill", { ...input, operationKey: "other-key" })).json();
    expect(other).toMatchObject({ result: { isError: true } });
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("rejects a ZIP whose real SKILL.md name disagrees with the requested name before SP writes", async () => {
    const app = setupManagement();
    const uploadRef = app.managed.addUpload("skill", "skill.zip", await skillZip("real-skill"));
    const result = await (await app.call("upload_agent_skill", {
      operationKey: "wrong-name", uploadRef, name: "other-skill", overwriteExistingSkill: true,
    })).json();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(app.sp.requestAgentLibrary).not.toHaveBeenCalled();
    expect(app.managed.operations.size).toBe(0);
  });

  it("records the attachment before Reference creation, recovers by its unique public URL and never deletes it", async () => {
    const app = setupManagement();
    const uploadRef = app.managed.addUpload("reference", "private.txt", new TextEncoder().encode("secret"), "text/plain");
    let reference: Record<string, unknown> | null = null;
    const upload = vi.fn(async (body: FormData) => {
      const file = body.get("file") as File;
      const clientAttachmentId = body.get("clientAttachmentId") as string;
      return {
        attachmentCdnUrl: `https://evalworkspace.springbrand.ai/uploads/v1/${OWNER}/${clientAttachmentId}`,
        clientAttachmentId, name: file.name, mediaType: file.type, size: file.size,
      };
    });
    const create = vi.fn(async (body: Record<string, unknown>) => {
      reference = { ...body, id: crypto.randomUUID(), status: "active" };
      throw new Error("Reference creation response lost");
    });
    app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
      const route = request.route as { path: string; method: string };
      if (route.path === "/inbox/attachments" && route.method === "post") {
        return upload((request as { body?: unknown }).body as FormData);
      }
      if (route.path === "/user-references" && route.method === "post") {
        return create((request as { body?: unknown }).body as Record<string, unknown>);
      }
      if (route.path === "/user-references") return { data: reference ? [reference] : [], total: reference ? 1 : 0 };
      if (route.path === "/user-references/{id}") return reference;
      throw new Error("No delete or arbitrary SP request is allowed");
    });
    const input = { operationKey: "reference-1", uploadRef };
    const lost = await (await app.call("upload_agent_reference", input)).json() as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(lost.result.content[0]!.text).toContain("OPERATION_OUTCOME_UNKNOWN");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown", stages: { attachment: "confirmed", reference: "attempted" } });
    const recovered = await toolValue(await app.call("upload_agent_reference", input));
    expect(recovered).toEqual({ referenceId: reference!.id, name: "private.txt" });
    expect(JSON.stringify(recovered)).not.toContain("https://");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const duplicate = await (await app.call("upload_agent_reference", {
      ...input, operationKey: "different-operation",
    })).json();
    expect(duplicate).toMatchObject({ result: { isError: true } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(app.sp.requestAgentLibrary.mock.calls.some(([, request]) =>
      (request.route as { method?: string }).method === "delete")).toBe(false);
  });

  it("refuses to replay an attachment if its upload response is unknown", async () => {
    const app = setupManagement();
    const uploadRef = app.managed.addUpload("reference", "a.txt", new TextEncoder().encode("x"), "text/plain");
    const upload = vi.fn(async () => { throw new Error("unknown attachment outcome"); });
    app.sp.requestAgentLibrary.mockImplementation(async () => upload());
    const input = { operationKey: "attachment-unknown", uploadRef };
    await app.call("upload_agent_reference", input);
    await app.call("upload_agent_reference", input);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown", stages: { attachment: "attempted" } });
  });
});
