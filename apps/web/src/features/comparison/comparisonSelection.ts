export type Candidate = { id: string; experimentId: string; name?: string; [key: string]: any };
export type Basket = { baselineRunId?: string; variantRunIds: string[] };

export function candidateUnion(experiments: any[], selectedExperimentIds: string[]): Candidate[] {
  const selected = new Set(selectedExperimentIds),
    seen = new Set<string>();
  return experiments
    .filter((e) => selected.has(e.id))
    .flatMap((e) =>
      (e.runs ?? []).flatMap((run: any) => {
        if (seen.has(run.id)) return [];
        seen.add(run.id);
        return [{ ...run, experimentId: run.experimentId ?? e.id }];
      })
    );
}
export function pageCandidates(runs: Candidate[], filter: string, requestedPage: number) {
  const needle = filter.trim().toLocaleLowerCase();
  const filtered = runs.filter((r) =>
    [r.id, r.name, r.experimentId].some((v) =>
      String(v ?? "")
        .toLocaleLowerCase()
        .includes(needle)
    )
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  return {
    items: filtered.slice(page * 50, (page + 1) * 50),
    filtered,
    total: filtered.length,
    page,
    pageCount
  };
}
export function changeBasket(
  basket: Basket,
  action: { kind: "baseline" | "toggle" | "remove" | "add"; id: string }
): Basket {
  let baselineRunId = basket.baselineRunId;
  const variants = new Set(basket.variantRunIds);
  if (action.kind === "baseline") {
    if (baselineRunId && baselineRunId !== action.id) variants.add(baselineRunId);
    baselineRunId = action.id || undefined;
  } else if (action.kind === "remove") {
    if (baselineRunId === action.id) baselineRunId = undefined;
    variants.delete(action.id);
  } else if (action.kind === "add") variants.add(action.id);
  else if (variants.has(action.id)) variants.delete(action.id);
  else if (baselineRunId !== action.id) variants.add(action.id);
  if (baselineRunId) variants.delete(baselineRunId);
  return { baselineRunId, variantRunIds: [...variants] };
}
