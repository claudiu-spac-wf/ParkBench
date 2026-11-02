export const fixtureSecret = "public-test-secret-not-a-credential";
export const fixtureMembers = Array.from({ length: 129 }, (_, n) => `member-${n}`);
export const fixtureScenarios = {
  slow: ["INFRASTRUCTURE", "HTTP", "BODY", "NATIVE_CAPTURE"],
  retries: [
    { controllerAttempt: 1, httpAttempt: 1 },
    { controllerAttempt: 1, httpAttempt: 2 },
    { controllerAttempt: 2, httpAttempt: 1 }
  ],
  telemetryOnly: [{ metricName: "parkbench_observer_up", value: 1 }],
  captures: [
    { generation: 1, value: 0 },
    { generation: 1, value: 0 },
    { generation: 2, value: 0 }
  ],
  cadencesMs: [1000, 5000, 10000],
  phase: { startMs: 10000, endMs: 20000, timestamps: [9999, 10000, 19999, 20000] },
  counters: {
    reset: [10, 12, 0, 2],
    conflict: [
      { timestamp: 1, value: 2 },
      { timestamp: 1, value: 3 }
    ]
  },
  applicability: [
    { scope: "primary", applicable: true },
    { scope: "alternate", applicable: false, reason: "alternate_pool_disabled" },
    { scope: "directory", statistic: "file_size", applicable: false, reason: "path_kind_directory" }
  ],
  unsafeError: `token=${fixtureSecret}`
};
