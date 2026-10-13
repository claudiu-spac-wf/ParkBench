# OpenEdge test fixtures

Non-live tests use synthetic manifests, request bodies, and temporary files.
Licensed Progress archives, `progress.cfg`, JDK layers, and generated Docker
outputs must never be copied into this directory or committed to the project.

The gated runtime suite copies the safe procedures under
`workloads/Workloads/` into a temporary workload root alongside the initial
packaged ParkBench workload. `Fixture/success.p` validates the JSON value passed
through `SingleParam`, `Fixture/failure.p` produces a bounded application
failure, and the timeout fixtures exercise cooperative and non-cooperative
request boundaries. `invalid/wrong-signature.p` is used only for package
validation failure tests.
