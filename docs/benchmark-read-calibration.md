# Benchmark read calibration

The reference target is 9,000,000,000 bytes of unique eligible data across the
16 read operations. It includes each full stored record and each requested
external LOB once. It excludes indexes, recovery files, unrequested LOBs, and
bytes reread by later requests. Allocated database extent size is not the target.

The canonical profile is `scripts/openedge/benchmark-read-profile.json`. Its
original conditional operation weights total 74. Native probes use NO-LOCK
reads, full `RECORD-LENGTH`, and stored BLOB/CLOB bytes without codepage
inflation. They build 1,000 RandomInt1000 buckets and independently verify the
selected cutoff and its predecessor. The cutoff is the smallest N whose
cumulative eligible bytes reach the target. An undersized seed uses N=1000
and records its actual smaller footprint.

The accepted `twentyeight_gb_lnx` report in
`examples/calibrations/parkbench-read-calibration.json` measured 10,352,764,658
eligible bytes. The smallest cutoff is N=870: 9,001,874,703 bytes (N=869 has
8,991,432,902 bytes). Rounding includes one complete bucket, 1,874,703 bytes above
the 9 GB target. This is a unique eligible footprint, not bytes reread during
measurement. The reference's approximately 28 GB allocated size also includes
indexes, unused space and data outside the requested read footprint.

The intended reference is `twentyeight_gb_lnx`. An accepted cutoff is published
only after independent native bracket and byte-accounting checks, source
fingerprint verification, and owned resource cleanup. Interrupted reports are
diagnostic evidence and cannot be used by the generator.

Large calibration scans use a maximum 2 GiB container ceiling (or the lower
operator limit), a 128 MiB database cache, and a 2 GiB host-headroom preflight.
The ceiling also bounds charged filesystem cache. Native memory accounting
showed that a 10 GiB calibration container filled almost entirely with file
cache; the ABL client itself used tens of MiB. The benchmark limit remains
independent so that normal 8 GiB cache experiments retain their configured
headroom. Run calibrations and native experiments sequentially.

## Reference verification

The native calibration command is:

```sh
node scripts/openedge/calibrate-read-footprint.mjs \
  --config .env.local \
  --seed /home/claudius/projects/PUG/parkbench_db_seed/twentyeight_gb_lnx \
  --output examples/calibrations/parkbench-read-calibration.json
```

Reference acceptance must also inspect the actual starting seed:

```sh
node scripts/openedge/calibrate-read-footprint.mjs \
  --verify-only --config .env.local \
  --seed /home/claudius/projects/PUG/parkbench_db_seed/twentyeight_gb_lnx \
  --calibration examples/calibrations/parkbench-read-calibration.json
```

Verification compares the data extent/structure manifest, native schema,
canonical read profile, and any partition map. Volatile logs and lock files are
excluded. Only `verified` exits successfully. Changed identities are `stale`;
missing or unreadable inspection evidence is `unverified`. Verification does
not rewrite the report, source database, scenarios, or saved results. It is an
acceptance check, not a production-run or comparison restriction.

Bounded scenarios must use a literal verified cutoff, a uniform band from 1 to
N, and `Limit=0`, retaining all original projections and requested LOBs. Every
admitted record must remain reachable. If an entire bucket exceeds the 60-second
request deadline, native-verified exhaustive primary-key partitions are required
before acceptance. Partition coverage and its canonical map hash must agree
with the report; it cannot be added by guessing inaccessible prefixes.

## Cache and memory

Use a combined 8 GiB cache budget for `-B` and `-B2`, calculated using the
actual database block size. For 8 KiB blocks their combined block count is
1,048,576. The split is an experiment choice; an alternate pool is not mandatory.
`PARKBENCH_DB_MEMORY_LIMIT=10g` leaves 2 GiB above that cache budget, applies a
hard DB container limit, and allows no additional swap. Native benchmark
experiments must run sequentially.


## Refresh and native acceptance

When refreshing seed data, rerun calibration against that seed, then regenerate
all four read-bearing presets. Commit the completed report and generated presets
together. A stale report fails verification and generation detects changed
profiles/coverage; build checks cannot inspect an external seed. The current
report records whole-bucket access. Exhaustive partitions, if needed, must be
native verified with a matching canonical partition-map hash; ordinary builds
cannot establish that proof.

```sh
node scripts/openedge/test-benchmark-readiness.mjs --suite bounded-reads \
  --config .env.local --seed /path/to/actual-starting-seed \
  --calibration examples/calibrations/parkbench-read-calibration.json \
  --report .parkbench/validation/feature019/bounded-reads.json
node scripts/openedge/test-benchmark-readiness.mjs --suite scenarios \
  --config .env.local --seed /path/to/actual-starting-seed \
  --calibration examples/calibrations/parkbench-read-calibration.json \
  --report .parkbench/validation/feature019/benchmark-scenarios.json
```

Both suites first run actual-seed verify-only acceptance. They use disposable
copies and bounded memory, preserve actual failures, and retain source/cleanup
evidence. Scenario acceptance refuses an already active native experiment and
runs standalone reads followed by the three 160-second mixes sequentially.
