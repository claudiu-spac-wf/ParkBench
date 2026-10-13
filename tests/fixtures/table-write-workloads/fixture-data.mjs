/* Independent test data. Never imports production generators or calls workloads. */
import { readInventory, readDomains } from "../../../scripts/openedge/generate-write-workloads.mjs";
export const fixtureOrder =
  "Currency,Country,AccountType,TransactionType,MerchantCategory,Branch,Employee,ExchangeRate,InterestRateHistory,Merchant,Customer,CustomerAddress,CustomerContact,CustomerDocument,CustomerNote,Account,AccountHolder,Payee,ScheduledPayment,Card,Loan,AccountStatement,MonthlyBalance,DebitTransaction,CreditTransaction,Transfer,LoanPayment,LoginEvent,CardAuthorization,AuditLog,StatementDocument,BenchmarkTableInfo".split(
    ","
  );
const date = (ordinal) => new Date(Date.UTC(2020, 0, ordinal)).toISOString().slice(0, 10);
export function fixtureData({
  variant = "success",
  count = 200,
  inventory = readInventory(),
  domains = readDomains()
} = {}) {
  if (!["success", "empty", "exhaustion"].includes(variant))
    throw new Error("write_fixture_variant_invalid");
  if (!Number.isInteger(count) || count < 100 || count > 1000 || count % 2)
    throw new Error("write_fixture_count_invalid");
  if (variant === "empty") return { variant, tables: [] };
  const prepared = new Map();
  const catalogs = structuredClone(domains.tables);
  catalogs.MerchantCategory = catalogs.MerchantCategory.flatMap((group) =>
    Array.from({ length: group.maximumCode - group.minimumCode + 1 }, (_, i) => ({
      MccCode: String(group.minimumCode + i),
      Description: group.CategoryGroup + " fixture",
      CategoryGroup: group.CategoryGroup
    }))
  );
  for (const name of fixtureOrder) {
    const table = inventory.tables.find((t) => t.name === name);
    let catalog = catalogs[name];
    if (name === "TransactionType" && variant === "success") {
      const debit = catalog.filter((row) => row.Direction === "D");
      const credit = catalog.filter((row) => row.Direction === "C");
      if (!debit.length || !credit.length)
        throw new Error("write_fixture_transaction_directions_missing");
      catalog = [...debit.slice(0, 3), ...credit.slice(0, 2)];
    }
    if (name === "Country") {
      const available = new Set(prepared.get("Currency").map((r) => r.CurrencyCode));
      catalog = catalog.filter((r) => available.has(r.DefaultCurrencyCode));
    }
    const size = catalog
      ? variant === "exhaustion"
        ? catalog.length
        : Math.min(5, catalog.length)
      : ["StatementDocument", "Transfer"].includes(name) && variant === "success"
        ? count / 2
        : count;
    const rows = Array.from({ length: size }, (_, index) => {
      const ordinal = index + 1;
      const row = {};
      for (const field of table.fields) {
        if (catalog && Object.hasOwn(catalog[index], field.name))
          row[field.name] = catalog[index][field.name];
        else if (field.name === table.primaryField) row[field.name] = ordinal;
        else if (/^RandomInt(10|100|1000)$/.test(field.name))
          row[field.name] = ordinal <= Math.min(120, Math.floor(size / 2)) ? 1 : 2;
        else if (field.relationship) {
          const rel = field.relationship;
          const parents = prepared.get(rel.parentTable);
          if (!parents?.length)
            throw new Error("write_fixture_parent_missing:" + name + "." + field.name);
          row[field.name] = rel.optional
            ? rel.absentValue
            : parents[index % parents.length][rel.parentField];
        } else if (field.lob)
          row[field.name] = {
            bytes: field.lob.defaultBytes,
            pattern: "Fixture " + name + "." + field.name + " "
          };
        else
          switch (field.type) {
            case "character": {
              const width = field.documentedCharacterWidth;
              row[field.name] = ("Fixture " + name + " " + field.name + " ")
                .repeat(Math.ceil(width / 10))
                .slice(0, Math.min(width, width > 300 ? Math.floor(width * 0.8) : 40))
                .trimEnd();
              break;
            }
            case "logical":
              row[field.name] = ordinal % 2 === 0;
              break;
            case "integer":
            case "int64":
              row[field.name] = 1;
              break;
            case "decimal":
              row[field.name] = Number((1.25).toFixed(field.decimals));
              break;
            case "date":
              row[field.name] = date(ordinal);
              break;
            case "datetime":
              row[field.name] = date(ordinal) + "T12:30:00.000";
              break;
            case "datetime-tz":
              row[field.name] = date(ordinal) + "T12:30:00.000+00:00";
              break;
            default:
              throw new Error("write_fixture_type_unhandled:" + field.type);
          }
      }
      for (const key of [
        "BranchCode",
        "EmployeeNumber",
        "MerchantNumber",
        "CustomerNumber",
        "AccountNumber",
        "LoanNumber",
        "CardToken",
        "TableName"
      ]) {
        const field = table.fields.find((f) => f.name === key);
        if (field)
          row[key] = "F" + String(ordinal).padStart(field.documentedCharacterWidth - 1, "0");
      }
      if (name === "AccountHolder") {
        row.AccountId = prepared.get("Account")[index % count].AccountId;
        row.CustomerId = prepared.get("Customer")[index % count].CustomerId;
      }
      if (["CreditTransaction", "DebitTransaction"].includes(name)) {
        const direction = name === "CreditTransaction" ? "C" : "D";
        const types = prepared.get("TransactionType").filter((row) => row.Direction === direction);
        if (!types.length) throw new Error("write_fixture_transaction_parent_missing");
        row.TransactionTypeId = types[index % types.length].TransactionTypeId;
      }
      if (name === "MonthlyBalance")
        row.BalanceMonth = new Date(Date.UTC(2020, index, 1)).toISOString().slice(0, 10);
      if (name === "AccountStatement") row.PeriodStart = date(ordinal);
      if (name === "BenchmarkTableInfo") row.TableName = "PBFixture" + ordinal;
      if (name === "Customer")
        Object.assign(row, {
          CustomerKind: "I",
          PreferredLanguage: "en",
          Segment: "RETAIL",
          CustomerStatus: "ACTIVE",
          RiskRating: "L",
          CreditScore: 700
        });
      if (name === "CustomerContact")
        Object.assign(row, {
          ContactKind: "EMAIL",
          ContactValue: "fixture" + ordinal + "@example.test"
        });
      if (name === "AuditLog") {
        row.TableName = "Account";
        row.RecordId = prepared.get("Account")[index % count].AccountId;
      }
      if (name === "Employee") row.Salary = 65000;
      if (name === "ExchangeRate") row.RateSource = "INTERNAL";
      return row;
    });
    prepared.set(name, rows);
  }
  return { variant, tables: fixtureOrder.map((name) => ({ name, rows: prepared.get(name) })) };
}
