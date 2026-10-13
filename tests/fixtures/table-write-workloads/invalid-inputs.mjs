const create = { Operation: "create", Limit: 1 };
const update = {
  Operation: "update",
  Limit: 1,
  WhereClause: "TRUE",
  FieldsList: ["JobTitle"],
  LobFields: []
};
export const invalidInputs = [
  ["malformed", "{"],
  ["null", "null"],
  ["array", "[]"],
  ["boolean", "true"],
  ["number", "1"],
  ["string", '"input"'],
  ...[undefined, null, "delete", "CREATE", 1, false].map((value) => [
    "Operation-" + String(value),
    JSON.stringify({ ...create, Operation: value })
  ]),
  ...[undefined, null, -1, 10001, 1.5, "1", true].map((value) => [
    "Limit-" + String(value),
    JSON.stringify({ ...create, Limit: value })
  ]),
  ...[null, true, 1, {}, [1], [null], [""]].flatMap((value) => [
    ["LobFields-" + JSON.stringify(value), JSON.stringify({ ...create, LobFields: value })],
    ["FieldsList-" + JSON.stringify(value), JSON.stringify({ ...update, FieldsList: value })]
  ]),
  ...[
    undefined,
    null,
    "",
    " ",
    1,
    false,
    "Employee.NoSuchField = 1",
    "TRUE) NO-LOCK BY Employee.EmployeeId",
    "/* unclosed",
    "'unclosed"
  ].map((value) => [
    "WhereClause-" + String(value),
    JSON.stringify({ ...update, WhereClause: value })
  ]),
  ...["unknown", "RUN", null, 1].map((value) => [
    "mode-" + String(value),
    JSON.stringify({ ...create, mode: value })
  ]),
  ["no-fields", JSON.stringify({ ...update, FieldsList: [] })],
  ["primary", JSON.stringify({ ...update, FieldsList: ["EmployeeId"] })],
  ["foreign-field", JSON.stringify({ ...update, FieldsList: ["CustomerId"] })],
  ["qualified-field", JSON.stringify({ ...update, FieldsList: ["Employee.JobTitle"] })],
  ["lob-in-ordinary", JSON.stringify({ ...update, FieldsList: ["Photo"] })],
  ["ordinary-in-lob", JSON.stringify({ ...create, LobFields: ["JobTitle"] })],
  ["foreign-lob", JSON.stringify({ ...create, LobFields: ["Content"] })]
];
export const validNoops = [
  [
    "zero-create-ignored-extras",
    { Operation: "create", Limit: 0, FieldsList: null, WhereClause: {} }
  ],
  ["zero-update", { ...update, Limit: 0, FieldsList: [] }],
  ["no-match", { ...update, WhereClause: "FALSE" }],
  ["readiness", { mode: "validate" }]
];
