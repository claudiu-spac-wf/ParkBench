const CPUSET_SETTINGS = [
  "PARKBENCH_PLATFORM_CPUSET",
  "PARKBENCH_PAS_CPUSET",
  "PARKBENCH_DB_CPUSET"
];

function parseCpuSet(value) {
  const input = String(value ?? "").trim();
  if (!input) return [];
  const ranges = [];
  for (const part of input.split(",")) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error("cpuset_invalid");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last)
      throw new Error("cpuset_invalid");
    ranges.push([first, last]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1)
    if (ranges[index][0] <= ranges[index - 1][1]) throw new Error("cpuset_invalid");
  return ranges;
}

function validateCpuSetConfiguration(env = process.env) {
  const configured = [];
  for (const setting of CPUSET_SETTINGS) {
    try {
      const ranges = parseCpuSet(env[setting]);
      if (ranges.length) configured.push({ setting, ranges });
    } catch {
      return { setting, reason: "invalid" };
    }
  }
  for (let leftIndex = 0; leftIndex < configured.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < configured.length; rightIndex += 1) {
      const left = configured[leftIndex];
      const right = configured[rightIndex];
      if (
        left.ranges.some(([leftStart, leftEnd]) =>
          right.ranges.some(
            ([rightStart, rightEnd]) => leftStart <= rightEnd && rightStart <= leftEnd
          )
        )
      )
        return { setting: right.setting, reason: "overlap" };
    }
  }
  return null;
}

function cpuSetForService(service, env = process.env) {
  const setting =
    service === "database"
      ? "PARKBENCH_DB_CPUSET"
      : /^pas-\d+$/.test(service)
        ? "PARKBENCH_PAS_CPUSET"
        : "PARKBENCH_PLATFORM_CPUSET";
  const value = String(env[setting] ?? "").trim();
  if (value) parseCpuSet(value);
  return value;
}

module.exports = { ...require("./db-memory.cjs"), CPUSET_SETTINGS, cpuSetForService, parseCpuSet, validateCpuSetConfiguration };
