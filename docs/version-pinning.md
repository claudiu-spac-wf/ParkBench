# Image references and versioning

Every ParkBench image setting must contain a repository name and an explicit tag other than `latest`. ParkBench uses the configured reference as supplied. Docker may accept an operator supplied `@sha256:...` suffix, but ParkBench does not generate, store, or compare image digests.

Managed file inputs use path-based `input:<category>/<relative-path>` references. Operators are responsible for knowing when an image, seed, archive, or other input has changed.
