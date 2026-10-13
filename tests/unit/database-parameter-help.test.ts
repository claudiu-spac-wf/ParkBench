import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DatabaseParameterHelp,
  parameterBoundText
} from "../../apps/web/src/features/experiments/DatabaseParameterHelp";
import { databaseParameterDefinition } from "../../packages/contracts/src/database-parameter-options";

it("retained options use their purpose and bounds without inventing defaults or unlimited ranges", () => {
  const legacy = renderToStaticMarkup(
    DatabaseParameterHelp({
      option: {
        name: "-old",
        description: "Retained cache setting",
        kind: "integer",
        minimum: 2,
        unit: "blocks"
      }
    })
  );
  assert.match(legacy, /Retained cache setting/);
  assert.match(legacy, /2 blocks/);
  assert.equal((legacy.match(/Not specified in documentation/g) ?? []).length, 2);
  assert.doesNotMatch(legacy, /Unlimited|Ownership|Verification|Registry|undefined/);
  const flag = renderToStaticMarkup(
    DatabaseParameterHelp({
      option: {
        name: "-oldflag",
        description: "Retained flag",
        kind: "boolean",
        defaultValue: false
      }
    })
  );
  assert.equal((flag.match(/Not applicable/g) ?? []).length, 2);
  assert.match(flag, /Disabled/);
});

it("help retains documented conditions and exact fractional units while explaining cache defaults", () => {
  assert.equal(
    parameterBoundText({ status: "documented", value: 0.015625 }, "MiB"),
    "0.015625 MiB"
  );
  assert.equal(
    parameterBoundText({ status: "documented", value: 32, condition: "when enabled" }, "blocks"),
    "32 blocks (when enabled)"
  );
  const html = renderToStaticMarkup(
    DatabaseParameterHelp({ option: databaseParameterDefinition("-B") })
  );
  assert.match(html, /Keeps database blocks in a shared memory cache/);
  assert.match(html, /Larger of 8 × the connection limit \(-n\) and 3,000 blocks/);
  assert.equal((html.match(/<dt>/g) ?? []).length, 3);
});

it("documented default discrepancies stay visible without internal implementation notes", () => {
  const html = renderToStaticMarkup(
    DatabaseParameterHelp({ option: databaseParameterDefinition("-lruskips") })
  );
  assert.match(html, /documentation lists 100 in its parameter table and 0 in its description/);
  assert.doesNotMatch(html, /override is injected|syntax table|Verification|Ownership/);
});

it("text defaults preserve meaning without duplicate unit labels or source footnote numbers", () => {
  const overflow = renderToStaticMarkup(
    DatabaseParameterHelp({ option: databaseParameterDefinition("-Mxs") })
  );
  assert.match(overflow, /32 KB plus extra space based on the number of users/);
  assert.doesNotMatch(overflow, /users KB/);
  const shared = renderToStaticMarkup(
    DatabaseParameterHelp({ option: databaseParameterDefinition("-shmsegsize") })
  );
  assert.match(shared, /first tries to allocate one segment for all required memory/);
  assert.doesNotMatch(shared, /dependent\. 2/);
});
