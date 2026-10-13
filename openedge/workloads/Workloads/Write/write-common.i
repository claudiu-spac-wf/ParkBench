FUNCTION pbGeneratorCleanup RETURNS LOGICAL () FORWARD.

/* Shared input, schema, query, and request resources. No database mutations. */
DEFINE VARIABLE pbParser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE pbPayload AS JsonObject NO-UNDO.
DEFINE VARIABLE pbMode AS CHARACTER CASE-SENSITIVE NO-UNDO.
DEFINE VARIABLE pbOperation AS CHARACTER CASE-SENSITIVE NO-UNDO.
DEFINE VARIABLE pbTable AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbPrimary AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbSequence AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbLimit AS INTEGER NO-UNDO.
DEFINE VARIABLE pbWhere AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbFields AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbLobs AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbTarget AS HANDLE NO-UNDO.
DEFINE VARIABLE pbQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE pbIgnored AS LOGICAL NO-UNDO.
DEFINE VARIABLE pbResult AS LOGICAL NO-UNDO.
DEFINE VARIABLE pbRowNumber AS INTEGER NO-UNDO.
DEFINE VARIABLE pbNewId AS INT64 NO-UNDO.
DEFINE VARIABLE pbMemory AS MEMPTR NO-UNDO.
DEFINE VARIABLE pbText AS LONGCHAR NO-UNDO.
DEFINE TEMP-TABLE pbField NO-UNDO
  FIELD fieldName AS CHARACTER FIELD ordinal AS INTEGER FIELD dataType AS CHARACTER
  FIELD fieldWidth AS INTEGER FIELD scale AS INTEGER FIELD parentTable AS CHARACTER
  FIELD parentField AS CHARACTER FIELD optionalParent AS LOGICAL FIELD lobBytes AS INTEGER
  FIELD policyKind AS CHARACTER FIELD policyValue AS CHARACTER FIELD policyChoices AS CHARACTER
  INDEX names IS UNIQUE fieldName INDEX ordering ordinal.
DEFINE TEMP-TABLE pbRequired NO-UNDO
  FIELD kind AS CHARACTER FIELD tableName AS CHARACTER FIELD itemName AS CHARACTER FIELD dataType AS CHARACTER
  INDEX requirements IS UNIQUE kind tableName itemName.
DEFINE TEMP-TABLE pbUniqueIndex NO-UNDO
  FIELD indexName AS CHARACTER FIELD components AS CHARACTER INDEX names IS UNIQUE indexName.
DEFINE TEMP-TABLE pbDomainRow NO-UNDO
  FIELD tableName AS CHARACTER FIELD ordinal AS INTEGER FIELD attributes AS CHARACTER
  INDEX domains IS UNIQUE tableName ordinal.
DEFINE TEMP-TABLE pbSelected NO-UNDO
  FIELD ordinal AS INTEGER FIELD recordRowid AS ROWID FIELD primaryId AS INT64
  INDEX ordering IS PRIMARY UNIQUE ordinal INDEX identities IS UNIQUE recordRowid.

/* Compiled only into isolated verification copies, never final workloads. */
&IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
DEFINE STREAM pbWitnessLog.
FUNCTION pbWitness RETURNS LOGICAL (INPUT fieldValue AS CHARACTER, INPUT kindValue AS CHARACTER):
  IF OS-GETENV("PARKBENCH_WRITE_WITNESS") = ? THEN
    UNDO, THROW NEW Progress.Lang.AppError("write_witness_path_required", 0).
  OUTPUT STREAM pbWitnessLog TO VALUE(OS-GETENV("PARKBENCH_WRITE_WITNESS")) APPEND.
  PUT STREAM pbWitnessLog UNFORMATTED pbTable "," pbNewId "," kindValue "," fieldValue SKIP.
  OUTPUT STREAM pbWitnessLog CLOSE.
  RETURN TRUE.
END FUNCTION.
&ENDIF

FUNCTION pbFail RETURNS LOGICAL (INPUT code AS CHARACTER):
  UNDO, THROW NEW Progress.Lang.AppError(code, 0).
END FUNCTION.

FUNCTION pbAddField RETURNS LOGICAL (INPUT nameValue AS CHARACTER, INPUT orderValue AS INTEGER,
  INPUT typeValue AS CHARACTER, INPUT widthValue AS INTEGER, INPUT scaleValue AS INTEGER,
  INPUT parentValue AS CHARACTER, INPUT parentKey AS CHARACTER, INPUT optionalValue AS LOGICAL,
  INPUT bytesValue AS INTEGER, INPUT kindValue AS CHARACTER, INPUT valueValue AS CHARACTER, INPUT choices AS CHARACTER):
  CREATE pbField.
  ASSIGN pbField.fieldName = nameValue pbField.ordinal = orderValue pbField.dataType = typeValue
    pbField.fieldWidth = widthValue pbField.scale = scaleValue pbField.parentTable = parentValue
    pbField.parentField = parentKey pbField.optionalParent = optionalValue pbField.lobBytes = bytesValue
    pbField.policyKind = kindValue pbField.policyValue = valueValue pbField.policyChoices = choices.
  RETURN TRUE.
END FUNCTION.

FUNCTION pbRequirement RETURNS LOGICAL (INPUT kindValue AS CHARACTER, INPUT tableValue AS CHARACTER,
  INPUT itemValue AS CHARACTER, INPUT typeValue AS CHARACTER):
  FIND pbRequired WHERE pbRequired.kind = kindValue AND pbRequired.tableName = tableValue
    AND pbRequired.itemName = itemValue NO-ERROR.
  IF NOT AVAILABLE pbRequired THEN DO:
    CREATE pbRequired.
    ASSIGN pbRequired.kind = kindValue pbRequired.tableName = tableValue
      pbRequired.itemName = itemValue pbRequired.dataType = typeValue.
  END.
  RETURN TRUE.
END FUNCTION.

FUNCTION pbUnique RETURNS LOGICAL (INPUT nameValue AS CHARACTER, INPUT fieldsValue AS CHARACTER):
  CREATE pbUniqueIndex.
  ASSIGN pbUniqueIndex.indexName = nameValue pbUniqueIndex.components = fieldsValue.
  RETURN TRUE.
END FUNCTION.

FUNCTION pbDomain RETURNS LOGICAL (INPUT tableValue AS CHARACTER, INPUT orderValue AS INTEGER, INPUT tupleValue AS CHARACTER):
  CREATE pbDomainRow.
  ASSIGN pbDomainRow.tableName = tableValue pbDomainRow.ordinal = orderValue pbDomainRow.attributes = tupleValue.
  RETURN TRUE.
END FUNCTION.

FUNCTION pbReadiness RETURNS LOGICAL ():
  FOR EACH pbRequired:
    FIND FIRST _File NO-LOCK WHERE _File._File-Name = pbRequired.tableName AND _File._Tbl-Type = "T" NO-ERROR.
    IF NOT AVAILABLE _File THEN RETURN pbFail("database_schema_invalid:table:" + pbRequired.tableName).
    CASE pbRequired.kind:
      WHEN "field" THEN DO:
        FIND FIRST _Field NO-LOCK WHERE _Field._File-recid = RECID(_File)
          AND _Field._Field-Name = pbRequired.itemName NO-ERROR.
        IF NOT AVAILABLE _Field THEN RETURN pbFail("database_schema_invalid:field:" + pbRequired.tableName + "." + pbRequired.itemName).
        IF _Field._Data-Type <> pbRequired.dataType THEN RETURN pbFail("database_schema_invalid:type:" + pbRequired.tableName + "." + pbRequired.itemName).
      END.
      WHEN "index" THEN DO:
        FIND FIRST _Index NO-LOCK WHERE _Index._File-recid = RECID(_File)
          AND _Index._Index-Name = pbRequired.itemName NO-ERROR.
        IF NOT AVAILABLE _Index THEN RETURN pbFail("database_schema_invalid:index:" + pbRequired.tableName + "." + pbRequired.itemName).
        IF NOT _Index._Active THEN RETURN pbFail("database_schema_invalid:index:" + pbRequired.tableName + "." + pbRequired.itemName).
      END.
    END CASE.
  END.
  FIND FIRST _Sequence NO-LOCK WHERE _Sequence._Seq-Name = pbSequence NO-ERROR.
  IF NOT AVAILABLE _Sequence THEN RETURN pbFail("database_schema_invalid:sequence:" + pbSequence).
  RETURN TRUE.
END FUNCTION.

FUNCTION pbNames RETURNS CHARACTER (INPUT keyValue AS CHARACTER, INPUT wantsLob AS LOGICAL):
  DEFINE VARIABLE names AS JsonArray NO-UNDO.
  DEFINE VARIABLE positionValue AS INTEGER NO-UNDO.
  DEFINE VARIABLE itemValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE resultValue AS CHARACTER NO-UNDO.
  IF NOT pbPayload:Has(keyValue) THEN RETURN "".
  IF pbPayload:IsNull(keyValue) OR pbPayload:GetType(keyValue) <> JsonDataType:ARRAY THEN DO:
    pbIgnored = pbFail("table_write_invalid:" + keyValue).
  END.
  names = pbPayload:GetJsonArray(keyValue).
  DO positionValue = 1 TO names:Length:
    IF names:GetType(positionValue) <> JsonDataType:STRING THEN pbIgnored = pbFail("table_write_invalid:" + keyValue).
    itemValue = names:GetCharacter(positionValue).
    FIND pbField WHERE pbField.fieldName = itemValue NO-ERROR.
    IF NOT AVAILABLE pbField THEN pbIgnored = pbFail("table_write_invalid:field").
    IF (pbField.lobBytes > 0) <> wantsLob THEN pbIgnored = pbFail("table_write_invalid:field_category").
    IF NOT wantsLob AND pbField.fieldName = pbPrimary THEN pbIgnored = pbFail("table_write_invalid:primary_id").
    IF LOOKUP(pbField.fieldName, resultValue) = 0 THEN
      resultValue = resultValue + (IF resultValue = "" THEN "" ELSE ",") + pbField.fieldName.
  END.
  RETURN resultValue.
END FUNCTION.

FUNCTION pbParse RETURNS LOGICAL ():
  DEFINE VARIABLE countValue AS DECIMAL NO-UNDO.
  pbParser = NEW ObjectModelParser().
  ASSIGN pbPayload = CAST(pbParser:Parse(SingleParam), JsonObject) NO-ERROR.
  IF ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 OR NOT VALID-OBJECT(pbPayload) THEN RETURN pbFail("table_write_invalid:input").
  pbMode = "run".
  IF pbPayload:Has("mode") THEN DO:
    IF pbPayload:GetType("mode") <> JsonDataType:STRING THEN RETURN pbFail("table_write_invalid:mode").
    pbMode = pbPayload:GetCharacter("mode").
    IF pbMode <> "run" AND pbMode <> "validate" THEN RETURN pbFail("table_write_invalid:mode").
  END.
  IF pbMode = "validate" THEN RETURN TRUE.
  IF NOT pbPayload:Has("Operation") OR NOT pbPayload:Has("Limit") THEN RETURN pbFail("table_write_invalid:required").
  IF pbPayload:GetType("Operation") <> JsonDataType:STRING OR pbPayload:GetType("Limit") <> JsonDataType:NUMBER THEN RETURN pbFail("table_write_invalid:required_type").
  pbOperation = pbPayload:GetCharacter("Operation").
  IF pbOperation <> "create" AND pbOperation <> "update" THEN RETURN pbFail("table_write_invalid:Operation").
  countValue = pbPayload:GetDecimal("Limit").
  IF countValue = ? OR countValue < 0 OR countValue > 10000 OR countValue <> TRUNCATE(countValue, 0) THEN RETURN pbFail("table_write_invalid:Limit").
  ASSIGN pbLimit = INTEGER(countValue) pbLobs = pbNames("LobFields", TRUE).
  IF pbOperation = "update" THEN DO:
    IF NOT pbPayload:Has("WhereClause") THEN RETURN pbFail("table_write_invalid:WhereClause").
    IF pbPayload:GetType("WhereClause") <> JsonDataType:STRING THEN RETURN pbFail("table_write_invalid:WhereClause").
    ASSIGN pbWhere = pbPayload:GetCharacter("WhereClause") pbFields = pbNames("FieldsList", FALSE).
    IF TRIM(pbWhere) = "" THEN RETURN pbFail("table_write_invalid:WhereClause").
    IF pbLimit > 0 AND pbFields = "" AND pbLobs = "" THEN RETURN pbFail("table_write_invalid:no_fields").
  END.
  CREATE BUFFER pbTarget FOR TABLE pbTable.
  RETURN TRUE.
END FUNCTION.

/* Parenthesized native expressions cannot close the server-owned query boundary.
   Quotes, tilde escapes, nested block comments, and line comments are respected. */
FUNCTION pbConditionBoundary RETURNS LOGICAL (INPUT conditionValue AS CHARACTER):
  DEFINE VARIABLE i AS INTEGER NO-UNDO.
  DEFINE VARIABLE depthValue AS INTEGER NO-UNDO.
  DEFINE VARIABLE commentDepth AS INTEGER NO-UNDO.
  DEFINE VARIABLE quoteValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE c AS CHARACTER NO-UNDO.
  DEFINE VARIABLE pairValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE lineComment AS LOGICAL NO-UNDO.
  DO i = 1 TO LENGTH(conditionValue):
    ASSIGN c = SUBSTRING(conditionValue, i, 1) pairValue = SUBSTRING(conditionValue, i, 2).
    IF lineComment THEN DO:
      IF c = "~n" OR c = "~r" THEN lineComment = FALSE.
      NEXT.
    END.
    IF commentDepth > 0 THEN DO:
      IF pairValue = "/*" THEN ASSIGN commentDepth = commentDepth + 1 i = i + 1.
      ELSE IF pairValue = "*/" THEN ASSIGN commentDepth = commentDepth - 1 i = i + 1.
      NEXT.
    END.
    IF quoteValue <> "" THEN DO:
      IF c = "~~" THEN i = i + 1.
      ELSE IF c = quoteValue THEN DO:
        IF SUBSTRING(conditionValue, i + 1, 1) = quoteValue THEN i = i + 1.
        ELSE quoteValue = "".
      END.
      NEXT.
    END.
    IF pairValue = "/*" THEN ASSIGN commentDepth = 1 i = i + 1.
    ELSE IF pairValue = "//" THEN ASSIGN lineComment = TRUE i = i + 1.
    ELSE IF c = CHR(34) OR c = CHR(39) THEN quoteValue = c.
    ELSE IF c = "(" THEN depthValue = depthValue + 1.
    ELSE IF c = ")" THEN DO:
      depthValue = depthValue - 1.
      IF depthValue < 0 THEN RETURN FALSE.
    END.
  END.
  RETURN depthValue = 0 AND commentDepth = 0 AND quoteValue = "".
END FUNCTION.

FUNCTION pbPrepareQuery RETURNS LOGICAL ():
  IF NOT pbConditionBoundary(pbWhere) THEN RETURN pbFail("table_write_invalid:condition_boundary").
  CREATE QUERY pbQuery.
  ASSIGN pbResult = pbQuery:SET-BUFFERS(pbTarget) NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN RETURN pbFail("table_write_query:buffers").
  ASSIGN pbResult = pbQuery:QUERY-PREPARE("FOR EACH " + pbTable + " WHERE (~n" + pbWhere
    + "~n) EXCLUSIVE-LOCK BY " + pbTable + "." + pbPrimary) NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN RETURN pbFail("table_write_invalid:WhereClause").
  RETURN TRUE.
END FUNCTION.

FUNCTION pbCleanup RETURNS LOGICAL ():
  pbIgnored = pbGeneratorCleanup().
  SET-SIZE(pbMemory) = 0.
  pbText = "".
  IF VALID-HANDLE(pbQuery) THEN DO:
    IF pbQuery:IS-OPEN THEN pbQuery:QUERY-CLOSE().
    DELETE OBJECT pbQuery.
  END.
  IF VALID-HANDLE(pbTarget) THEN DO:
    /* Cleanup must not validate an already failed record again or replace the
       original ERROR/STOP object while its transaction is being undone. */
    pbTarget:BUFFER-RELEASE() NO-ERROR.
    DELETE OBJECT pbTarget NO-ERROR.
  END.
  IF VALID-OBJECT(pbPayload) THEN DELETE OBJECT pbPayload.
  IF VALID-OBJECT(pbParser) THEN DELETE OBJECT pbParser.
  RETURN TRUE.
END FUNCTION.
