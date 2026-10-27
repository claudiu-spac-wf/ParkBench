import { api } from "../../api";
import {
  ReportMetadata,
  ReportType,
  REPORT_VERSION
} from "../../../../../packages/contracts/src/database-analysis-report";
export const reportsApi = {
  seeds: (signal?: AbortSignal) => api<any>("/catalog/assets?kind=seed&pageSize=250", { signal }),
  list: (query: URLSearchParams, signal?: AbortSignal) => api<any>("/reports?" + query, { signal }),
  create: (seedAssetId: string, type: ReportType, key: string) =>
    api<{ report: ReportMetadata }>("/reports", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        contractVersion: REPORT_VERSION,
        family: "database-analysis",
        seedAssetId,
        type
      })
    }),
  detail: (id: string, signal?: AbortSignal) =>
    api<{ report: ReportMetadata }>("/reports/" + encodeURIComponent(id), { signal }),
  cancel: (id: string) =>
    api<{ report: ReportMetadata }>("/reports/" + encodeURIComponent(id) + "/cancel", {
      method: "POST",
      body: "{}"
    }),
  result: (id: string, path: string, signal?: AbortSignal) =>
    api<any>("/reports/" + encodeURIComponent(id) + "/" + path, { signal }),
  definitions: (columnsVersion?: string, rulesVersion?: string, signal?: AbortSignal) =>
    api<any>(
      "/reports/definitions?" +
        new URLSearchParams({
          ...(columnsVersion ? { columnsVersion } : {}),
          ...(rulesVersion ? { rulesVersion } : {})
        }),
      { signal }
    )
};
