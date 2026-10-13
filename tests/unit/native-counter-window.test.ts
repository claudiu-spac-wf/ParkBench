import assert from "node:assert/strict";
import { it } from "node:test";
import golden from "../fixtures/benchmark-readiness/native-series.json";
import { counterWindow } from "../../apps/control-plane/src/grafana/native-counter-window";
it("matches independent steady/reset/zero counters and refuses gaps or one point", () => {
  for (const fixture of golden.counterCases) {
    const result = counterWindow(fixture.samples as [number, number | null][], 0, 10, 5);
    if (fixture.expectedAvailable === false) assert.equal(result, null, fixture.name);
    else {
      assert.equal(result?.increase, fixture.expectedIncrease, fixture.name);
      assert.equal(result?.rate, fixture.expectedRate, fixture.name);
    }
  }
});
it("does not invent activity across stale coverage and extrapolates covered endpoint edges", () => {
  assert.equal(
    counterWindow(
      [
        [0, 100],
        [5, 150]
      ],
      0,
      100,
      5
    ),
    null
  );
  const extrapolated = counterWindow(
    [
      [1, 110],
      [5, 150],
      [9, 190]
    ],
    0,
    10,
    5
  );
  assert.equal(extrapolated?.increase, 100);
  assert.equal(
    counterWindow(
      [
        [0, 100],
        [30, 200]
      ],
      0,
      30,
      5
    ),
    null
  );
  assert.equal(
    counterWindow(
      [
        [0, 100],
        [5, null],
        [10, 200],
        [15, 250]
      ],
      0,
      15,
      5
    ),
    null
  );
});

it("uses the Prometheus left-open range boundary before reset extrapolation", () => {
  assert.equal(
    counterWindow(
      [
        [0, 500],
        [5, 100],
        [10, 110]
      ],
      0,
      10,
      5
    )?.increase,
    20
  );
});
