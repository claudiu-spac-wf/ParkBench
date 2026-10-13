import {
  COMPARISON_METRIC_CATALOG_VERSION,
  COMPARISON_METRIC_CATALOG,
  validateMetricSelections,
  type MetricSelection
} from "../../../../../packages/contracts/src/comparison-metric-selection";
export const PRESET_STORAGE_KEY = "parkbench.comparisonMetricPresets.v1";
export interface MetricPreset {
  id: string;
  name: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  catalogVersion: string;
  descriptorVersions: Record<string, number>;
  selections: MetricSelection[];
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const nameOf = (name: string) => {
  const n = name.normalize("NFC").trim();
  if (n.length < 1 || Array.from(n).length > 80)
    throw new Error("Preset name must contain 1–80 characters.");
  return n;
};
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
function validatePreset(p: any): p is MetricPreset {
  try {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      p.id.length > 256 ||
      typeof p.name !== "string" ||
      nameOf(p.name) !== p.name ||
      typeof p.revision !== "string" ||
      !p.revision ||
      typeof p.catalogVersion !== "string" ||
      !p.descriptorVersions ||
      typeof p.descriptorVersions !== "object" ||
      !Object.values(p.descriptorVersions).every((v) => Number.isSafeInteger(v) && Number(v) > 0) ||
      !Number.isFinite(Date.parse(p.createdAt)) ||
      !Number.isFinite(Date.parse(p.updatedAt))
    )
      return false;
    validateMetricSelections(p.selections, 256, true);
    return true;
  } catch {
    return false;
  }
}
export function createMetricPresetStore(getStorage: () => StorageLike = () => window.localStorage) {
  const raw = () => {
    let text: string | null;
    try {
      text = getStorage().getItem(PRESET_STORAGE_KEY);
    } catch {
      throw new Error(
        "Browser preset storage is unavailable. Your selected metrics remain usable."
      );
    }
    if (text === null) return { schemaVersion: 1 as const, presets: [] as unknown[] };
    try {
      if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error();
      const value = JSON.parse(text);
      if (value.schemaVersion !== 1 || !Array.isArray(value.presets) || value.presets.length > 100)
        throw new Error();
      return value as { schemaVersion: 1; presets: unknown[] };
    } catch {
      throw new Error(
        "Browser preset storage is corrupt or uses an unsupported version. Existing content was preserved."
      );
    }
  };
  const read = () => {
    try {
      const envelope = raw(),
        ids = new Set<string>(),
        names = new Set<string>();
      let invalid = 0;
      const presets = envelope.presets.filter((p): p is MetricPreset => {
        if (!validatePreset(p) || ids.has(p.id) || names.has(p.name)) {
          invalid++;
          return false;
        }
        ids.add(p.id);
        names.add(p.name);
        return true;
      });
      return {
        presets,
        warning: invalid
          ? `${invalid} invalid preset record(s) are unavailable; other presets remain usable.`
          : undefined
      };
    } catch (e) {
      return { presets: [] as MetricPreset[], warning: (e as Error).message };
    }
  };
  const write = (envelope: { schemaVersion: 1; presets: unknown[] }) => {
    const text = JSON.stringify(envelope);
    if (envelope.presets.length > 100 || new TextEncoder().encode(text).length > 256 * 1024)
      throw new Error("Browser preset storage limit exceeded (100 presets / 256 KiB).");
    try {
      getStorage().setItem(PRESET_STORAGE_KEY, text);
    } catch {
      throw new Error(
        "Could not save browser presets. Storage is unavailable or full; your selected metrics remain usable."
      );
    }
  };
  const metadata = (selections: MetricSelection[]) => {
    validateMetricSelections(selections, 256, true);
    return {
      catalogVersion: COMPARISON_METRIC_CATALOG_VERSION,
      descriptorVersions: Object.fromEntries(
        selections.map((m) => [
          m.metricId,
          COMPARISON_METRIC_CATALOG.find((d) => d.metricId === m.metricId)?.version ?? 1
        ])
      ),
      selections: structuredClone(selections)
    };
  };
  const current = (envelope: ReturnType<typeof raw>, id: string, revision: string) => {
    const i = envelope.presets.findIndex((p: any) => validatePreset(p) && p.id === id);
    if (i < 0 || (envelope.presets[i] as MetricPreset).revision !== revision)
      throw new Error(
        "Preset conflict: this preset changed in another tab. Refresh the preset list and retry."
      );
    return i;
  };
  return {
    read,
    save(name: string, selections: MetricSelection[]) {
      const n = nameOf(name),
        m = metadata(selections),
        envelope = raw();
      if (envelope.presets.some((p: any) => p?.name === n))
        throw new Error(
          "preset_name_exists: use Replace preset explicitly or choose a different name."
        );
      const now = new Date().toISOString(),
        preset: MetricPreset = {
          id: uuid(),
          revision: uuid(),
          name: n,
          createdAt: now,
          updatedAt: now,
          ...m
        };
      envelope.presets.push(preset);
      write(envelope);
      return preset;
    },
    replace(id: string, revision: string, selections: MetricSelection[]) {
      const envelope = raw(),
        i = current(envelope, id, revision);
      const p: MetricPreset = {
        ...(envelope.presets[i] as MetricPreset),
        ...metadata(selections),
        revision: uuid(),
        updatedAt: new Date().toISOString()
      };
      envelope.presets[i] = p;
      write(envelope);
      return p;
    },
    delete(id: string, revision: string) {
      const envelope = raw(),
        i = current(envelope, id, revision);
      envelope.presets.splice(i, 1);
      write(envelope);
    }
  };
}
export function presetWarnings(preset: MetricPreset): string[] {
  return preset.selections.flatMap((m) => {
    const d = COMPARISON_METRIC_CATALOG.find((d) => d.metricId === m.metricId);
    return !d
      ? [`Metric unavailable: ${m.metricId}`]
      : preset.descriptorVersions[m.metricId] !== d.version
        ? [`Metric definition changed: ${m.metricId}. Review this choice.`]
        : [];
  });
}
