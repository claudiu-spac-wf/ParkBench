export const iopsOwner = (overrides: Record<string, unknown> = {}) => ({
  daemonId: "daemon-fixture",
  containerId: "a".repeat(64),
  pid: 123,
  startedAt: "2026-11-02T00:00:00.000Z",
  runId: "iops-fixture-1",
  composeProject: "parkbench-iops-fixture-1",
  component: "database" as const,
  ...overrides
});
export const iopsCoverage = (count = 1) => ({
  owner: iopsOwner(),
  workingRoot: "/psc/wrk/fixture",
  devices: Array.from({ length: count }, (_, i) => ({
    id: `8:${i}`,
    path: `/dev/fixture${i}`,
    filesystem: "ext4",
    mountId: `${i + 1}`,
    generation: "1",
    paths: [`/psc/wrk/fixture/data${i}`]
  }))
});
export const legacyIopsRun = { id: "before-feature025", environmentSnapshot: {} };
export const unrelatedControls = {
  BlkioWeight: 500,
  BlkioDeviceReadBps: [{ Path: "/dev/fixture0", Rate: 1048576 }],
  Memory: 268435456,
  NanoCpus: 1000000000
};
