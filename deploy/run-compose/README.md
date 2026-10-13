# Per-run Compose bundle

The control plane renders this template with pinned operator inputs and a unique
project name. Every resource receives `parkbench.managed=true`, the run and
experiment IDs, and a component label. Cleanup selects resources using those
exact labels. The generated bundle is retained as a run artifact.
