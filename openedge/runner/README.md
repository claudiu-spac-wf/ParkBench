# ParkBench PASOE workload runner

The runner exposes health and metrics endpoints plus one benchmark endpoint:
`POST /work`. The request envelope is `{ "procName": "Workloads/...p", "input":
<JSON value> }`. The selected procedure receives the compact JSON input as its
only `LONGCHAR` parameter named `SingleParam`. PASOE serves the handler below
the WEB transport, so its full initial URL is `/parkbench/web/work`.

The generic runner is reusable and contains no business application. The final
image is produced by adding procedures from `openedge/workloads/Workloads`.
