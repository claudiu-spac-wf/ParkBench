export function pasReplicaServices(replicas: number): string[] {
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 8)
    throw new Error("pas_replicas_out_of_range");
  return Array.from({ length: replicas }, (_, i) => `pas-${i + 1}`);
}
