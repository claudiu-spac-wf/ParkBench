import fs from "node:fs";

const SECRET_KEYS = /password|secret|token|credential|authorization|private.?key/i;
export function redactSecrets(value: unknown, additionalSecrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, additionalSecrets));
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of additionalSecrets.filter((item) => item.length >= 3))
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted.replace(
      /(password|secret|token|authorization|private[ _-]?key)\s*([:=])\s*([^\s,;]+)/gi,
      "$1$2[REDACTED]"
    );
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSafeReferenceKey(key)
          ? redactSecrets(child, additionalSecrets)
          : SECRET_KEYS.test(key)
            ? "[REDACTED]"
            : redactSecrets(child, additionalSecrets)
      ])
    );
  return value;
}

export function runtimeSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      /(PASSWORD|TOKEN|SECRET|AUTHORIZATION|CREDENTIAL_(?!REF|FILE))/i.test(key) &&
      value.length >= 3
    )
      values.push(value);
    if (value && /CREDENTIAL_FILE/i.test(key)) {
      try {
        const stat = fs.statSync(value);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          const fileValue = fs.readFileSync(value, "utf8").trim();
          if (fileValue.length >= 3) values.push(fileValue);
        }
      } catch {
        // Missing/unreadable credential files are reported by preflight, not redaction.
      }
    }
  }
  return [...new Set(values)];
}

/** Resolve only bounded text from private local inputs for log redaction. */
export function privateInputValues(references: unknown[]): string[] {
  const values: string[] = [];
  for (const reference of references) {
    if (typeof reference !== "string" || reference.startsWith("input:")) continue;
    try {
      const stat = fs.statSync(reference);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const content = fs.readFileSync(reference, "utf8");
      if (content.length >= 3) values.push(content);
    } catch {
      // Input validation owns the error; this helper must never make logging fail.
    }
  }
  return values;
}

function isSafeReferenceKey(key: string): boolean {
  return /(?:credential|secret|token|key).*ref$/i.test(key);
}
