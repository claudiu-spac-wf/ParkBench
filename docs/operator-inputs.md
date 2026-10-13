# Operator inputs

OpenEdge images, licenses, database seeds, application archives, and runtime
credentials are supplied locally or through a private registry. ParkBench stores
identifiers and file paths; it never stores credential values or private
installation material in SQLite, labels, logs, or artifacts.

The Catalog UI discovers Docker images from the local daemon and discovers
scenarios, workloads, observers, seeds, archives, and configurations from the
managed roots configured by `PARKBENCH_DISCOVERY_*_ROOT`. Discovery records
retain safe names and relative provenance only. Missing roots appear
as empty, unreadable sources as degraded, and stale, malformed, unclassified,
or unverified inputs cannot be selected for a new run.
