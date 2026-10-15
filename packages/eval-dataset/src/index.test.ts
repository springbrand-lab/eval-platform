import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-dataset", () => {
  it("exports only the Dataset service, its model, document parsing and errors", () => {
    expect(Object.keys(entry).toSorted()).toEqual([
      "assertPromptData", "assertPromptDatasetMetadata", "createDatasetService", "DataInUseError",
      "DatasetEntityNotFoundError", "DatasetIdentityConflictError", "DatasetInputError", "dataInputSchema",
      "dataSchema", "datasetInputSchema", "datasetSchema", "datasetSnapshotSchema", "initialMaterialsRefSchema", "initialSessionRefSchema",
      "parseDatasetDocument", "parseStrictJson", "platformIdSchema", "promptDatasetUploadSchema",
    ].toSorted());
  });
});
