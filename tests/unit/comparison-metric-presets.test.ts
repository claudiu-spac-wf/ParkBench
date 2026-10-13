import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createMetricPresetStore,
  PRESET_STORAGE_KEY
} from "../../apps/web/src/features/comparison/metricPresets";
const selections = [
  { metricId: "workload.completed", statistics: ["total"] as any, selectors: {} }
];
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data
  };
}
it("explicit mutations normalize names, preserve unrelated records and require current revisions", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  const a = store.save(" e\u0301 ", selections),
    b = store.save("Other", selections);
  assert.equal(a.name, "é");
  assert.throws(() => store.save("é", selections), /name_exists/);
  const changed = store.replace(a.id, a.revision, []);
  assert.throws(() => store.replace(a.id, a.revision, selections), /conflict/);
  assert.throws(() => store.delete(a.id, a.revision), /conflict/);
  store.delete(a.id, changed.revision);
  assert.deepEqual(
    store.read().presets.map((p) => p.id),
    [b.id]
  );
});
it("storage failures leave existing content intact and report a usable error", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  store.save("A", selections);
  const before = s.getItem(PRESET_STORAGE_KEY);
  const denied = createMetricPresetStore(() => {
    throw new Error("denied");
  });
  assert.match(denied.read().warning ?? "", /unavailable/);
  assert.throws(() => denied.save("X", selections), /unavailable/);
  s.setItem = () => {
    throw new Error("quota");
  };
  assert.throws(() => store.save("B", selections), /save/);
  assert.equal(s.getItem(PRESET_STORAGE_KEY), before);
});
it("isolates invalid records, preserves future metric ids and does not overwrite corrupt envelopes", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  const a = store.save("A", selections);
  const envelope = JSON.parse(s.getItem(PRESET_STORAGE_KEY)!);
  envelope.presets.push({ bad: "record" });
  envelope.presets[0].selections = [
    { metricId: "future.metric", statistics: ["value"], selectors: {} }
  ];
  s.setItem(PRESET_STORAGE_KEY, JSON.stringify(envelope));
  assert.equal(store.read().presets[0].selections[0].metricId, "future.metric");
  assert.ok(store.read().warning);
  store.save("B", selections);
  assert.deepEqual(JSON.parse(s.getItem(PRESET_STORAGE_KEY)!).presets[1], { bad: "record" });
  s.setItem(PRESET_STORAGE_KEY, "{bad");
  assert.throws(() => store.replace(a.id, a.revision, []), /corrupt/);
  assert.equal(s.getItem(PRESET_STORAGE_KEY), "{bad");
});
it("enforces names, count, selection and byte bounds with no implicit overwrite", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  assert.throws(() => store.save(" ", []));
  assert.throws(() => store.save("x".repeat(81), []));
  assert.throws(() => store.save("A", Array(257).fill(selections[0])));
  for (let i = 0; i < 100; i++) store.save(String(i), []);
  assert.throws(() => store.save("101", []), /limit/);
});

it("enforces the serialized byte limit and preserves existing content on rejection", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  const large = Array.from({ length: 256 }, (_, i) => ({
    metricId: String(i).padStart(4, "0") + "." + "x".repeat(240),
    statistics: ["value"] as any,
    selectors: {}
  }));
  store.save("Large first", large);
  const before = s.getItem(PRESET_STORAGE_KEY);
  assert.throws(() => store.save("Large second", large), /limit/);
  assert.equal(s.getItem(PRESET_STORAGE_KEY), before);
});

it("retains stale statistics and selectors for individual removal while rejecting structural duplicates and forbidden selectors", () => {
  const s = storage(),
    store = createMetricPresetStore(() => s);
  const valid: any = {
    metricId: "resource.platform.cpu.usage",
    statistics: ["average"],
    selectors: {}
  };
  const stale: any = { ...valid, statistics: ["value"] };
  const removedSelector: any = { ...valid, selectors: { retiredDimension: "recorded" } };
  store.save("Review stale", [valid, stale, removedSelector]);
  assert.deepEqual(store.read().presets[0].selections, [valid, stale, removedSelector]);
  assert.throws(() => store.save("Duplicate", [valid, { ...valid }]), /duplicate/);
  assert.throws(
    () => store.save("Forbidden", [{ ...valid, selectors: { run_id: "other" } }]),
    /selector/
  );
});
