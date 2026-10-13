import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataFactory } from "../../apps/loadgen/src/data-factory";
import { renderTemplateValues } from "../../apps/loadgen/src/template-values";
import { renderBody } from "../../apps/loadgen/src/runner";

const band = { band: { kind: "uniformInt" as const, min: 1, max: 1000 } };
const body = (where: string) => ({
  procName: "Workloads/Generic/arbitrary_reads.p",
  input: { mode: "run", TableName: "DebitTransaction", WhereClause: where, Limit: 2000 }
});

function draws(seed: number, count: number, declarations = band): number[] {
  const factory = new DataFactory(seed);
  return Array.from({ length: count }, () => {
    const rendered = renderTemplateValues(
      body("RandomInt1000 = {{band}}"),
      declarations,
      factory
    ) as any;
    return Number(rendered.input.WhereClause.split("= ")[1]);
  });
}

describe("scenario templateValues rendering", () => {
  it("draws whole numbers inside the inclusive range", () => {
    const values = draws(2026, 10_000);
    assert.ok(values.every((value) => Number.isInteger(value) && value >= 1 && value <= 1000));
    assert.ok(values.includes(1) || values.some((value) => value < 5));
    assert.ok(values.some((value) => value > 995));
    const fixed = draws(7, 50, { band: { kind: "uniformInt", min: 42, max: 42 } });
    assert.ok(fixed.every((value) => value === 42));
  });

  it("is deterministic for a seed and differs between seeds", () => {
    assert.deepEqual(draws(2026, 200), draws(2026, 200));
    assert.notDeepEqual(draws(2026, 200), draws(2027, 200));
  });

  it("draws declared names in ascending order and reuses one value per name", () => {
    const declarations = {
      zeta: { kind: "uniformInt" as const, min: 0, max: 1_000_000 },
      alpha: { kind: "uniformInt" as const, min: 0, max: 1_000_000 }
    };
    const reference = new DataFactory(11);
    const alpha = Math.floor(reference.next() * 1_000_001);
    const zeta = Math.floor(reference.next() * 1_000_001);
    const rendered = renderTemplateValues(
      { a: "{{alpha}}-{{alpha}}", nested: [{ z: "x{{zeta}}y" }, "{{alpha}}"], n: 5, b: true },
      declarations,
      new DataFactory(11)
    ) as any;
    assert.equal(rendered.a, `${alpha}-${alpha}`);
    assert.equal(rendered.nested[0].z, `x${zeta}y`);
    assert.equal(rendered.nested[1], String(alpha));
    assert.equal(rendered.n, 5);
    assert.equal(rendered.b, true);
  });

  it("leaves templates without declarations untouched and draws nothing", () => {
    const template = body("RandomInt1000 = 5");
    const factory = new DataFactory(99);
    assert.equal(renderTemplateValues(template, undefined, factory), template);
    assert.equal(renderTemplateValues(template, {}, factory), template);
    assert.equal(factory.next(), new DataFactory(99).next());
  });

  it("keeps generated key substitution working beside placeholders", () => {
    const factory = new DataFactory(5);
    const rendered = renderBody(
      renderTemplateValues(
        { input: { WhereClause: "RandomInt1000 = {{band}}", key: "generated" } },
        band,
        factory
      ),
      factory
    ) as any;
    assert.match(rendered.input.WhereClause, /^RandomInt1000 = \d+$/);
    assert.deepEqual(Object.keys(rendered.input.key).sort(), ["name", "sequence", "value"]);
  });
});
