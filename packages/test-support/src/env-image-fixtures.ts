import imageReferences from "../../../tests/fixtures/image-references.json";

export function imageReferenceFixtures(): typeof imageReferences {
  return structuredClone(imageReferences);
}

export function redactedValidationError(error: unknown): string {
  return String(error).replace(/(=|:)[^\s:,]+/g, "$1<redacted>");
}

export function environmentFixture(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PARKBENCH_IMAGE_TAG: "fixture",
    PARKBENCH_LOADGEN_IMAGE: "parkbench/loadgen:fixture",
    PARKBENCH_OBSERVER_IMAGE: "parkbench/observer:fixture",
    ...overrides
  };
}
