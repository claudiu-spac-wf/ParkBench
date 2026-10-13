export function assertCapacity(input: {
  cpu: number;
  memoryBytes: number;
  freeBytes: number;
}): void {
  if (
    input.cpu < 1 ||
    input.memoryBytes < 512 * 1024 * 1024 ||
    input.freeBytes < 1024 * 1024 * 1024
  )
    throw new Error("host_capacity_insufficient");
}
