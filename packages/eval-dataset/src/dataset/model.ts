import type { JsonValue } from "@eval-platform/eval-contracts";

export interface Dataset {
  readonly datasetId: string;
  readonly name: string;
  readonly description?: string;
}

export type InitialMaterialsSpec =
  | {
      readonly kind: "file-bundle";
      readonly bundleId: string;
      readonly manifestHash?: string;
    }
  | {
      readonly kind: "generated";
      readonly generatorId: string;
      readonly parameters: Readonly<Record<string, JsonValue>>;
    };

export interface Data {
  readonly dataId: string;
  readonly externalDataId?: string;
  readonly json: JsonValue;
  readonly initialContext?: JsonValue;
  readonly initialMaterials?: InitialMaterialsSpec;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
