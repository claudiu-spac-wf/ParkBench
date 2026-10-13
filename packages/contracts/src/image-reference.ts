export type ImageIdentityStrength = "tag";

export interface ParsedImageReference {
  reference: string;
  repository: string;
  tag: string;
  identityStrength: ImageIdentityStrength;
}

export interface ImageIdentitySnapshot {
  configuredReference: string;
  reference: string;
  identityStrength: ImageIdentityStrength;
}

export type ImageReferenceErrorCode =
  | "image_reference_required"
  | "image_reference_whitespace"
  | "image_reference_tag_required"
  | "image_reference_latest_forbidden"
  | "image_reference_malformed";

export class ImageReferenceError extends Error {
  readonly code: ImageReferenceErrorCode;
  constructor(code: ImageReferenceErrorCode) {
    super(code);
    this.name = "ImageReferenceError";
    this.code = code;
  }
}

export type ImageTagErrorCode =
  "image_tag_required" | "image_tag_invalid" | "image_tag_latest_forbidden";

export class ImageTagError extends Error {
  readonly code: ImageTagErrorCode;
  constructor(code: ImageTagErrorCode) {
    super(code);
    this.name = "ImageTagError";
    this.code = code;
  }
}

export function parseImageTag(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ImageTagError("image_tag_required");
  if (value.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value))
    throw new ImageTagError("image_tag_invalid");
  if (value.toLowerCase() === "latest") throw new ImageTagError("image_tag_latest_forbidden");
  return value;
}

export const validateImageTag = parseImageTag;

export function parseImageReference(value: unknown): ParsedImageReference {
  if (typeof value !== "string" || !value)
    throw new ImageReferenceError("image_reference_required");
  if (/\s/.test(value)) throw new ImageReferenceError("image_reference_whitespace");
  const at = value.indexOf("@");
  const named = at >= 0 ? value.slice(0, at) : value;
  if (!named) throw new ImageReferenceError("image_reference_malformed");
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  if (colon <= slash) {
    throw new ImageReferenceError("image_reference_tag_required");
  }
  const repository = named.slice(0, colon);
  const tag = named.slice(colon + 1);
  if (!repository || !tag || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag))
    throw new ImageReferenceError("image_reference_malformed");
  if (tag.toLowerCase() === "latest")
    throw new ImageReferenceError("image_reference_latest_forbidden");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(repository))
    throw new ImageReferenceError("image_reference_malformed");
  return {
    reference: value,
    repository,
    tag,
    identityStrength: "tag"
  };
}

export function isValidImageReference(value: unknown): value is string {
  try {
    parseImageReference(value);
    return true;
  } catch {
    return false;
  }
}

export function imageIdentitySnapshot(
  configuredReference: string,
  resolved: Record<string, unknown> | undefined
): ImageIdentitySnapshot {
  parseImageReference(configuredReference);
  void resolved;
  return {
    configuredReference,
    reference: configuredReference,
    identityStrength: "tag"
  };
}
