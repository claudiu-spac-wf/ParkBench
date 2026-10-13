/** One literal UTF-8 argument per line; no shell parsing is involved. */
export function encodeDatabaseArgv(tokens: readonly string[]): string {
  if (tokens.length > 2048) throw new Error("database_argv_invalid:token_limit");
  for (const token of tokens)
    if (
      typeof token !== "string" ||
      /[\0\r\n]/.test(token) ||
      new TextEncoder().encode(token).length > 65536 ||
      new TextDecoder().decode(new TextEncoder().encode(token)) !== token
    )
      throw new Error("database_argv_invalid:literal_argv_transport");
  const text = tokens.map((t) => `${t}\n`).join("");
  if (new TextEncoder().encode(text).length > 256 * 1024)
    throw new Error("database_argv_invalid:size");
  return text;
}
