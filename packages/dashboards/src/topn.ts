/**
 * Top-N with "Other" (research R6). Membership is ranked once per run over the whole
 * selected range (`[$__range] @ end()`), so series never change identity along the chart.
 * Every view of one ranking (rate and totals, read and write) shares the identical `top`
 * sub-expression.
 */
export interface RankingInput {
  /** Label identifying a ranked entry, for example `table` or `service`. */
  key: string;
  n: number;
  /**
   * Per-(run_id, key) total over `[$__range] @ end()`. `extra` is an additional label
   * matcher list (without braces, possibly empty) spliced into every selector.
   */
  score: (extra: string) => string;
  /** Matcher that keeps an entry out of the ranking (for example `table!="other"`). */
  excludeFromRanking?: string;
  /** Run-independent tie-break series joined on `key` (tables only). */
  bias?: string;
}

export interface Ranking {
  top: string;
  /** Keeps only the ranked entries of a per-(run_id, key) expression. */
  named(expr: string): string;
  /**
   * Sums the unranked entries of a per-(run_id, key) expression into one "Other" series.
   * The series is omitted for a run whose unranked entries had no activity in the range.
   */
  other(expr: string): string;
}

export function ranking(input: RankingInput): Ranking {
  const { key, n } = input;
  const by = `run_id, ${key}`;
  const base = `(${input.score(input.excludeFromRanking ?? "")}) > 0`;
  const scored = input.bias
    ? `((${base}) + on (${key}) group_left () ${input.bias}) or (${base})`
    : base;
  const top = `topk by (run_id) (${n}, ${scored})`;
  const gate = `(sum by (run_id) ((${input.score("")}) unless on (${by}) (${top})) > 0)`;
  return {
    top,
    named: (expr) => `((${expr}) and on (${by}) (${top}))`,
    other: (expr) =>
      `(label_replace(sum by (run_id) ((${expr}) unless on (${by}) (${top})), "${key}", "Other", "", "") and on (run_id) ${gate})`
  };
}

/** Named entries plus "Other" for one expression. */
export function withOther(rank: Ranking, expr: string): string {
  return `${rank.named(expr)} or ${rank.other(expr)}`;
}

/** Totals for a bar chart: named entries plus "Other", sorted by value. */
export function totals(rank: Ranking, score: string): string {
  return `sort_desc(${withOther(rank, score)})`;
}
