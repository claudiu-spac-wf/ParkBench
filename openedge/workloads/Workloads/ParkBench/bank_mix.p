/* ParkBench banking mix for ParkBenchDB seeds (contract: bank_mix.contract.json).
   mode "validate": read-only check that the tables, fields, indexes and sequence the
   contract declares exist, and that BenchmarkTableInfo knows each read table.
   mode "run": one operation chosen by "op". Rows come from "key", the load generator's
   deterministic {name, value, sequence} record, so a run with the same effective load
   seed replays the same rows. Row counts outside the contract bounds fail the request. */
BLOCK-LEVEL ON ERROR UNDO, THROW.

USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.

DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
DEFINE VARIABLE payload AS JsonObject NO-UNDO.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE keyObject AS JsonObject NO-UNDO.
DEFINE VARIABLE workMode AS CHARACTER NO-UNDO.
DEFINE VARIABLE workOp AS CHARACTER NO-UNDO.
DEFINE VARIABLE keyName AS CHARACTER NO-UNDO.
DEFINE VARIABLE keyValue AS INT64 NO-UNDO.
DEFINE VARIABLE keySequence AS INT64 NO-UNDO.
DEFINE VARIABLE maxId AS INT64 NO-UNDO.
DEFINE VARIABLE targetId AS INT64 NO-UNDO.
DEFINE VARIABLE startId AS INT64 NO-UNDO.
DEFINE VARIABLE newId AS INT64 NO-UNDO.
DEFINE VARIABLE rowCount AS INTEGER NO-UNDO.
DEFINE VARIABLE requirement AS CHARACTER NO-UNDO.
DEFINE VARIABLE requirementIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE objectName AS CHARACTER NO-UNDO.
DEFINE VARIABLE dataType AS CHARACTER NO-UNDO.

/* Keep in step with requiredFields / requiredIndexes / requiredSequences in the contract. */
&SCOPED-DEFINE REQUIRED_FIELDS "BenchmarkTableInfo.TableName:character,BenchmarkTableInfo.MaxId:int64,CustomerContact.RandomInt100:integer,AccountHolder.RandomInt1000:integer,DebitTransaction.DebitTransactionId:int64,AuditLog.AuditLogId:int64,AuditLog.ChangeSummary:character"
&SCOPED-DEFINE REQUIRED_INDEXES "CustomerContact.IxRandomInt100,AccountHolder.IxRandomInt1000,DebitTransaction.PkDebitTransaction,AuditLog.PkAuditLog"
&SCOPED-DEFINE READ_TABLES "Currency,Branch,AccountType,CustomerContact,AccountHolder,DebitTransaction"

FUNCTION tableMaxId RETURNS INT64 (INPUT pTableName AS CHARACTER):
  FIND FIRST BenchmarkTableInfo NO-LOCK
    WHERE BenchmarkTableInfo.TableName = pTableName NO-ERROR.
  RETURN IF AVAILABLE BenchmarkTableInfo THEN BenchmarkTableInfo.MaxId ELSE 0.
END FUNCTION.

parser = NEW ObjectModelParser().
payload = CAST(parser:Parse(SingleParam), JsonObject).
ASSIGN workMode = payload:GetCharacter("mode") NO-ERROR.
IF ERROR-STATUS:ERROR OR workMode = ? THEN RETURN ERROR "invalid_work_mode".

IF workMode = "validate" THEN DO:
  DO requirementIndex = 1 TO NUM-ENTRIES({&REQUIRED_FIELDS}):
    requirement = ENTRY(requirementIndex, {&REQUIRED_FIELDS}).
    ASSIGN
      tableName = ENTRY(1, ENTRY(1, requirement, ":"), ".")
      objectName = ENTRY(2, ENTRY(1, requirement, ":"), ".")
      dataType = ENTRY(2, requirement, ":").
    FIND FIRST _File NO-LOCK WHERE _File._File-Name = tableName AND _File._Tbl-Type = "T" NO-ERROR.
    IF NOT AVAILABLE _File THEN RETURN ERROR "database_schema_invalid:table:" + tableName.
    FIND FIRST _Field NO-LOCK
      WHERE _Field._File-recid = RECID(_File) AND _Field._Field-Name = objectName NO-ERROR.
    IF NOT AVAILABLE _Field OR _Field._Data-Type <> dataType THEN
      RETURN ERROR "database_schema_invalid:field:" + tableName + "." + objectName.
  END.
  DO requirementIndex = 1 TO NUM-ENTRIES({&REQUIRED_INDEXES}):
    requirement = ENTRY(requirementIndex, {&REQUIRED_INDEXES}).
    ASSIGN tableName = ENTRY(1, requirement, ".") objectName = ENTRY(2, requirement, ".").
    FIND FIRST _File NO-LOCK WHERE _File._File-Name = tableName AND _File._Tbl-Type = "T" NO-ERROR.
    IF NOT AVAILABLE _File THEN RETURN ERROR "database_schema_invalid:table:" + tableName.
    FIND FIRST _Index NO-LOCK
      WHERE _Index._File-recid = RECID(_File) AND _Index._Index-Name = objectName NO-ERROR.
    IF NOT AVAILABLE _Index OR NOT _Index._Active THEN
      RETURN ERROR "database_schema_invalid:index:" + requirement.
  END.
  FIND FIRST _Sequence NO-LOCK WHERE _Sequence._Seq-Name = "SeqAuditLogId" NO-ERROR.
  IF NOT AVAILABLE _Sequence THEN RETURN ERROR "database_schema_invalid:sequence:SeqAuditLogId".
  DO requirementIndex = 1 TO NUM-ENTRIES({&READ_TABLES}):
    tableName = ENTRY(requirementIndex, {&READ_TABLES}).
    IF tableMaxId(tableName) < 1 THEN
      RETURN ERROR "database_schema_invalid:benchmark_table_info:" + tableName.
  END.
  RETURN.
END.
IF workMode <> "run" THEN RETURN ERROR "invalid_work_mode".

ASSIGN workOp = payload:GetCharacter("op") NO-ERROR.
IF ERROR-STATUS:ERROR OR workOp = ? THEN RETURN ERROR "invalid_work_mode".
ASSIGN keyObject = payload:GetJsonObject("key") NO-ERROR.
IF ERROR-STATUS:ERROR OR NOT VALID-OBJECT(keyObject) THEN RETURN ERROR "invalid_work_input".
ASSIGN
  keyName = keyObject:GetCharacter("name")
  keyValue = keyObject:GetInt64("value")
  keySequence = keyObject:GetInt64("sequence") NO-ERROR.
IF ERROR-STATUS:ERROR OR keyName = ? OR keyValue = ? OR keySequence = ? OR
   keyValue < 0 OR keySequence < 0 THEN
  RETURN ERROR "invalid_work_input".

CASE workOp:
  WHEN "reference-point" THEN DO:
    /* Point reads by dense Id on the tiny reference tables; 0..1 row each. */
    maxId = tableMaxId("Currency").
    targetId = 1 + (keySequence MODULO MAXIMUM(maxId, 1)).
    FIND FIRST Currency NO-LOCK WHERE Currency.CurrencyId = targetId NO-ERROR.
    maxId = tableMaxId("Branch").
    targetId = 1 + (keySequence MODULO MAXIMUM(maxId, 1)).
    FIND FIRST Branch NO-LOCK WHERE Branch.BranchId = targetId NO-ERROR.
    maxId = tableMaxId("AccountType").
    targetId = 1 + (keySequence MODULO MAXIMUM(maxId, 1)).
    FIND FIRST AccountType NO-LOCK WHERE AccountType.AccountTypeId = targetId NO-ERROR.
  END.
  WHEN "selective" THEN DO:
    /* Indexed 1% / 0.1% predicates on the random fields; 0..1000 rows each. */
    rowCount = 0.
    FOR EACH CustomerContact NO-LOCK
        WHERE CustomerContact.RandomInt100 = 1 + INTEGER(keyValue MODULO 100):
      rowCount = rowCount + 1.
      IF rowCount >= 1000 THEN LEAVE.
    END.
    IF rowCount > 1000 THEN
      RETURN ERROR "workload_bounds_violated:selective:CustomerContact:" + STRING(rowCount).
    rowCount = 0.
    FOR EACH AccountHolder NO-LOCK
        WHERE AccountHolder.RandomInt1000 = 1 + INTEGER(keySequence MODULO 1000):
      rowCount = rowCount + 1.
      IF rowCount >= 1000 THEN LEAVE.
    END.
    IF rowCount > 1000 THEN
      RETURN ERROR "workload_bounds_violated:selective:AccountHolder:" + STRING(rowCount).
  END.
  WHEN "range" THEN DO:
    /* A bounded 100-row ordered range on the largest transaction table; 1..100 rows. */
    maxId = tableMaxId("DebitTransaction").
    startId = 1 + (keySequence MODULO MAXIMUM(1, maxId - 100)).
    rowCount = 0.
    FOR EACH DebitTransaction NO-LOCK
        WHERE DebitTransaction.DebitTransactionId >= startId
        BY DebitTransaction.DebitTransactionId:
      rowCount = rowCount + 1.
      IF rowCount >= 100 THEN LEAVE.
    END.
    IF rowCount < 1 OR rowCount > 100 THEN
      RETURN ERROR "workload_bounds_violated:range:DebitTransaction:" + STRING(rowCount).
  END.
  WHEN "audit-write-cycle" THEN DO TRANSACTION:
    /* Create, update and delete one AuditLog row in the run-owned copy; net change zero. */
    newId = NEXT-VALUE(SeqAuditLogId).
    CREATE AuditLog.
    ASSIGN
      AuditLog.AuditLogId = newId
      AuditLog.RandomInt10 = 1 + INTEGER(keySequence MODULO 10)
      AuditLog.RandomInt100 = 1 + INTEGER(keySequence MODULO 100)
      AuditLog.RandomInt1000 = 1 + INTEGER(keySequence MODULO 1000)
      AuditLog.CreatedAt = NOW
      AuditLog.EventDateTime = NOW
      AuditLog.TableName = "Account"
      AuditLog.RecordId = 1 + (keyValue MODULO 1000000)
      AuditLog.AuditAction = "C"
      AuditLog.EmployeeId = 0
      AuditLog.ChangeSummary = SUBSTRING(keyName, 1, 60).
    RELEASE AuditLog.
    FIND FIRST AuditLog EXCLUSIVE-LOCK WHERE AuditLog.AuditLogId = newId NO-ERROR.
    IF NOT AVAILABLE AuditLog THEN
      RETURN ERROR "workload_bounds_violated:audit-write-cycle:AuditLog:0".
    ASSIGN
      AuditLog.AuditAction = "U"
      AuditLog.ChangeSummary = SUBSTRING("updated " + keyName, 1, 60).
    DELETE AuditLog.
  END.
  OTHERWISE
    RETURN ERROR "invalid_work_mode".
END CASE.
