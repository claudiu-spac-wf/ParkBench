/**
 * Dependency-free scanner that finds every vector/matrix selector in a PromQL expression
 * (implementation baseline T001(i)). It does not evaluate PromQL; it only has to locate
 * selectors and their label matchers reliably so the ParkBench Runs datasource can enforce
 * the run-scope rule (grafana-runs-datasource.v1 R1).
 */
export interface LabelMatcher {
  name: string;
  op: "=" | "!=" | "=~" | "!~";
  value: string;
  /** Offsets of the whole matcher text (`name op "value"`) within the expression. */
  start: number;
  end: number;
}

export interface Selector {
  metric?: string;
  matchers: LabelMatcher[];
  start: number;
  end: number;
}

export class PromqlScanError extends Error {}

const KEYWORDS = new Set([
  "and",
  "or",
  "unless",
  "bool",
  "offset",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "inf",
  "nan",
  "atan2"
]);
/** Aggregation operators may be followed by `by (…)`/`without (…)` before their `(`. */
const AGGREGATIONS = new Set([
  "sum",
  "min",
  "max",
  "avg",
  "group",
  "stddev",
  "stdvar",
  "count",
  "count_values",
  "bottomk",
  "topk",
  "quantile",
  "limitk",
  "limit_ratio"
]);
const LABEL_LIST_KEYWORDS = new Set([
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right"
]);

const isIdentStart = (c: string) => /[A-Za-z_:]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_:]/.test(c);

function readString(expr: string, index: number): { value: string; end: number } {
  const quote = expr[index];
  let value = "";
  let i = index + 1;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "\\" && quote !== "`") {
      const next = expr[i + 1];
      if (next === undefined) break;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 2;
      continue;
    }
    if (c === quote) return { value, end: i + 1 };
    value += c;
    i += 1;
  }
  throw new PromqlScanError("unterminated_string");
}

function skipSpace(expr: string, index: number): number {
  let i = index;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) i += 1;
    else if (expr[i] === "#") {
      while (i < expr.length && expr[i] !== "\n") i += 1;
    } else break;
  }
  return i;
}

function skipBalanced(expr: string, index: number, open: string, close: string): number {
  let depth = 0;
  let i = index;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      i = readString(expr, i).end;
      continue;
    }
    if (c === open) depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new PromqlScanError(`unbalanced_${open}`);
}

function readMatchers(expr: string, index: number): { matchers: LabelMatcher[]; end: number } {
  const matchers: LabelMatcher[] = [];
  let i = skipSpace(expr, index + 1);
  while (i < expr.length && expr[i] !== "}") {
    const start = i;
    let name: string;
    if (expr[i] === '"' || expr[i] === "'") {
      const quoted = readString(expr, i);
      name = quoted.value;
      i = quoted.end;
    } else {
      let j = i;
      while (j < expr.length && isIdent(expr[j])) j += 1;
      if (j === i) throw new PromqlScanError("invalid_label_matcher");
      name = expr.slice(i, j);
      i = j;
    }
    i = skipSpace(expr, i);
    // A bare quoted name with no operator is a metric name in the UTF-8 selector syntax.
    if (expr[i] === "," || expr[i] === "}") {
      matchers.push({ name: "__name__", op: "=", value: name, start, end: i });
    } else {
      const two = expr.slice(i, i + 2);
      const op = (["=~", "!~", "!="].includes(two) ? two : expr[i]) as LabelMatcher["op"];
      if (!["=", "!=", "=~", "!~"].includes(op)) throw new PromqlScanError("invalid_label_matcher");
      i = skipSpace(expr, i + op.length);
      if (!['"', "'", "`"].includes(expr[i])) throw new PromqlScanError("invalid_label_matcher");
      const quoted = readString(expr, i);
      i = quoted.end;
      matchers.push({ name, op, value: quoted.value, start, end: i });
    }
    i = skipSpace(expr, i);
    if (expr[i] === ",") i = skipSpace(expr, i + 1);
  }
  if (expr[i] !== "}") throw new PromqlScanError("unbalanced_{");
  return { matchers, end: i + 1 };
}

/** Returns every selector in `expr`, in order of appearance. */
export function scanSelectors(expr: string): Selector[] {
  const selectors: Selector[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c) || c === "#") {
      i = skipSpace(expr, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = readString(expr, i).end;
      continue;
    }
    if (c === "[") {
      i = skipBalanced(expr, i, "[", "]");
      continue;
    }
    if (/[0-9.]/.test(c)) {
      while (i < expr.length && /[0-9A-Za-z_.]/.test(expr[i])) i += 1;
      continue;
    }
    if (c === "{") {
      const { matchers, end } = readMatchers(expr, i);
      const nameMatcher = matchers.find(
        (matcher) => matcher.name === "__name__" && matcher.op === "="
      );
      selectors.push({ metric: nameMatcher?.value, matchers, start: i, end });
      i = end;
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < expr.length && isIdent(expr[i])) i += 1;
      const word = expr.slice(start, i);
      const after = skipSpace(expr, i);
      const lower = word.toLowerCase();
      if (LABEL_LIST_KEYWORDS.has(lower)) {
        i = expr[after] === "(" ? skipBalanced(expr, after, "(", ")") : after;
        continue;
      }
      if (KEYWORDS.has(lower) || AGGREGATIONS.has(lower)) continue;
      if (expr[after] === "(") {
        i = after;
        continue;
      }
      if (expr[after] === "{") {
        const { matchers, end } = readMatchers(expr, after);
        selectors.push({ metric: word, matchers, start, end });
        i = end;
        continue;
      }
      selectors.push({ metric: word, matchers: [], start, end: i });
      continue;
    }
    i += 1;
  }
  return selectors;
}

/**
 * Parses a run matcher value into literal run IDs. `=` takes the value as one ID. `=~`
 * accepts literal alternatives only, optionally wrapped in `(…)` and regex-escaped the way
 * Grafana formats multi-value variables. Returns undefined for anything else.
 */
export function literalRunIds(matcher: Pick<LabelMatcher, "op" | "value">): string[] | undefined {
  const idPattern = /^[A-Za-z0-9_.-]+$/;
  if (matcher.op === "=") return idPattern.test(matcher.value) ? [matcher.value] : undefined;
  if (matcher.op !== "=~") return undefined;
  let value = matcher.value.trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1);
  if (!value) return undefined;
  const ids = value.split("|").map((part) => part.replace(/\\([.\-_])/g, "$1"));
  return ids.every((id) => idPattern.test(id)) ? [...new Set(ids)] : undefined;
}
