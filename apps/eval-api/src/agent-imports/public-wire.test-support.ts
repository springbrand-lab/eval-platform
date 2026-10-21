/** Literal current SP source-export setting fixture, not an Eval implementation of SP's normalizer. */
export function canonicalSourceSettingFixture() {
  return {
    presetId: null, model: null, thinking: "high", systemPrompt: null,
    toolPolicy: { allow: [], deny: [] }, subagentNames: ["fanout", "extract"], executionLevel: "high",
    memoryDefaults: { enabled: true, memoryTokens: 2000, preferencesTokens: 500 }, sandbox: { enabled: false },
    skillIds: [] as string[], mcpServers: [] as { serverId: string; kind?: "connector_toolkit" }[],
    actionIds: [] as string[], referenceFileIds: [] as string[], connectorIds: [] as string[], extensionIds: [] as string[],
  };
}
