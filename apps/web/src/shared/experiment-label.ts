export interface NamedExperiment {
  id: string;
  name?: string;
  runCount?: number;
  runs?: Array<{ name?: string }>;
}

export function experimentDisplayName(experiment: NamedExperiment): string {
  if (!experiment.name) return experiment.id;
  const firstRun = experiment.runs?.find((run) => run.name)?.name;
  if (!firstRun) return experiment.name;
  const count = experiment.runCount ?? experiment.runs?.length ?? 1;
  return `${experiment.name} · ${firstRun}${count > 1 ? ` +${count - 1} more` : ""}`;
}
