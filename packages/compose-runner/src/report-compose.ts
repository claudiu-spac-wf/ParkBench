import { isValidImageReference } from "../../contracts/src/image-reference";
import path from "node:path";
import { dockerHostPath } from "./orchestrator";
import { ReportType } from "../../contracts/src/database-analysis-report";
export interface ReportComposeOptions {
  reportId: string;
  token: string;
  directory: string;
  seedPath: string;
  databaseName: string;
  image: string;
  type: ReportType;
  aliases: string[];
  licensePath?: string;
}
export function reportContainerName(reportId: string, token: string, stage: string) {
  return `pb-report-${reportId}-${token.slice(0, 8)}-${stage}`;
}
/** Runs native analysis alongside the experiment DB entrypoint in the same container. */
export const REPORT_CONTAINER_SCRIPT = `set -eu
database_pid=
analysis_pid=
shutdown() {
  trap - EXIT TERM INT
  if [ -n "$analysis_pid" ]; then
    kill -TERM "$analysis_pid" 2>/dev/null || true
    wait "$analysis_pid" 2>/dev/null || true
  fi
  if [ -n "$database_pid" ]; then
    kill -TERM "$database_pid" 2>/dev/null || true
    wait "$database_pid" 2>/dev/null || true
  fi
}
trap shutdown EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
/usr/local/bin/parkbench-db-entrypoint.sh &
database_pid=$!
database="/psc/wrk/$DB_NAME/$DB_NAME"
while :; do
  if ! kill -0 "$database_pid" 2>/dev/null; then
    wait "$database_pid" || true
    echo report_database_start_failed >&2
    exit 52
  fi
  if [ -f "/psc/wrk/$DB_NAME/.parkbench-db-name" ] && pgrep -x _mprosrv >/dev/null 2>&1; then
    busy=0
    /psc/dlc/bin/proutil "$database" -C busy > /reports/execution/readiness.log 2>&1 || busy=$?
    case "$busy" in
      6) break ;;
      0|64) : ;;
      *) echo report_database_start_failed >&2; exit 52 ;;
    esac
  fi
  sleep 1
done
"$@" &
analysis_pid=$!
status=0
wait "$analysis_pid" || status=$?
analysis_pid=
exit "$status"
`.replaceAll("$", () => "$$");
export function buildReportCompose(o: ReportComposeOptions) {
  if (!isValidImageReference(o.image)) throw new Error("report_tool_unavailable");
  if (
    !/^[a-z][a-z0-9_]{0,31}$/.test(o.databaseName) ||
    !["DBANALYS", "IDXANALYS", "TABANALYS"].includes(o.type)
  )
    throw new Error("report_seed_invalid");
  const volumes: any[] = [
    {
      type: "bind",
      source: dockerHostPath(o.seedPath),
      target: "/run/parkbench/seed/db",
      read_only: true
    },
    { type: "bind", source: dockerHostPath(o.directory), target: "/reports" },
    {
      type: "bind",
      source: dockerHostPath(path.join(o.directory, "scratch")),
      target: "/psc/wrk"
    }
  ];
  if (o.licensePath)
    volumes.push({
      type: "bind",
      source: dockerHostPath(o.licensePath),
      target: "/psc/dlc/progress.cfg",
      read_only: true
    });
  const commands: Record<string, { entrypoint: string[]; command: string[] }> = {
    version: { entrypoint: ["/psc/dlc/bin/proutil"], command: ["-?"] },
    analysis: {
      entrypoint: ["/bin/sh", "-c", REPORT_CONTAINER_SCRIPT, "parkbench-report"],
      command: [
        "/psc/dlc/bin/proutil",
        `/psc/wrk/${o.databaseName}/${o.databaseName}`,
        "-C",
        o.type.toLowerCase(),
        "-csoutput",
        "-fieldsep",
        ",",
        "-verbose",
        "-csfilePrefix",
        "report"
      ]
    }
  };
  return {
    name: `pb-report-${o.reportId}`,
    services: Object.fromEntries(
      Object.entries(commands).map(([stage, cmd]) => [
        stage,
        {
          image: o.image,
          container_name: reportContainerName(o.reportId, o.token, stage),
          ...cmd,
          environment: {
            DB_NAME: o.databaseName,
            PARKBENCH_DB_INIT_MODE: "seed",
            PARKBENCH_DB_WORKDIR: "/psc/wrk",
            PARKBENCH_SEED_DB_DIR: "/run/parkbench/seed/db",
            PARKBENCH_DATABASE_READ_ONLY: "false",
            PARKBENCH_DATABASE_RUN_CONTROLS: ""
          },
          working_dir: "/reports/raw",
          network_mode: "none",
          restart: "no",
          labels: {
            "parkbench.resource_kind": "report",
            "parkbench.report_id": o.reportId,
            "parkbench.owner_token": o.token
          },
          volumes
        }
      ])
    )
  } as any;
}
