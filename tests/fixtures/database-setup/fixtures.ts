/** Public synthetic inputs only; no licensed database or private script contents. */
export const rawSetupInputs = [
  "",
  "   ",
  '\"customer group\" --mode=fast',
  "line1\nline2\n\n",
  "x | cat; true",
  "\0",
  "x".repeat(200_000)
];
export const builtinSetup = {
  contractVersion: "database-setup.v1",
  steps: [
    {
      id: "reorganize",
      definitionId: "tablereorg",
      optionSets: [
        { id: "customers", table: "PUB.Customer", useIndex: "CustNum" },
        {
          id: "orders",
          table: "PUB.Order",
          useIndex: "OrderNum",
          additionalArguments: ["recs", "1000"]
        }
      ]
    },
    {
      id: "build",
      definitionId: "idxbuild",
      optionSets: [
        { id: "customers", scope: "table", table: "PUB.Customer" },
        { id: "orders", scope: "table", table: "PUB.Order" }
      ]
    },
    {
      id: "compact",
      definitionId: "idxcompact",
      optionSets: [
        { id: "first", index: "PUB.Customer.CustNum", compactionPercent: 80 },
        { id: "again", index: "PUB.Customer.CustNum", compactionPercent: 80 }
      ]
    }
  ]
};
export const customSetup = (inputs = rawSetupInputs) => ({
  contractVersion: "database-setup.v1",
  steps: [
    {
      id: "custom",
      definitionId: "custom",
      scriptRef: "input:scripts/with spaces/prepare.sh",
      optionSets: inputs.map((input, i) => ({ id: `set-${i}`, input }))
    }
  ]
});
export const legacySchedule = {
  runName: "legacy-setup",
  scenario: { id: "s", version: "1" },
  dimensions: [],
  repetitions: 2
};
