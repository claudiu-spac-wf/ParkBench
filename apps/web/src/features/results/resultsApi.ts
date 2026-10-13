import { api } from "../../api";
export const getComparison = (id: string) => api<any>(`/comparisons/${id}`);
export const getArtifacts = (id: string) => api<any>(`/runs/${id}/artifacts`);
export const getRuns = (id: string) => api<any>(`/experiments/${id}/runs`);
export const getExperiments = () => api<any>("/experiments");
export const comparisonExportUrl = (id: string) => `/api/v1/comparisons/${id}/export`;
