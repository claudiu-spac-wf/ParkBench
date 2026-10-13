/* Generic dynamic read workload (contract: arbitrary_reads.contract.json).
   input: {"mode": "run" | "validate", "TableName": "...", "WhereClause": "...",
           "Limit": n, "FieldsList": ["..."], "LobFields": ["..."]}
   mode "run": repeats read passes until at least 1000 ms have passed since the request
   started, so HTTP overhead does not dominate; at least one pass always runs. Each pass
   opens a NO-LOCK dynamic query over TableName/WhereClause, counts the records and stops
   once the count would exceed Limit (Limit null, absent or <= 0 means no limit). Every
   LobFields value of each record read is copied into a MEMPTR, so the database really
   ships the LOB, and the MEMPTR is released straight away. A non-empty FieldsList becomes
   a FIELDS phrase (LobFields are added to it) so only those fields are returned.
   mode "validate": checks the parameters and prepares the query without reading data.
   The request timer is a local ETIME baseline: ParkBenchWorkHandler owns the session
   timer and resets it itself, so this procedure must never reset it.
   LOB fetch: COPY-LOB FROM <buffer-field>:BUFFER-VALUE TO <memptr> NO-ERROR. Verified on
   OpenEdge 12.8.11 for dynamic BLOB and CLOB fields: copying an unknown LOB raises no
   error, and (? = <buffer-field>:BUFFER-VALUE) detects unknown values. A failed copy is
   therefore accepted only when the value is unknown; any other failure raises
   arbitrary_reads_failed.
   The procedure never locks, creates, updates or deletes records. */
BLOCK-LEVEL ON ERROR UNDO, THROW.

USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.

DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.

DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE payload AS JsonObject NO-UNDO.
DEFINE VARIABLE workMode AS CHARACTER NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE whereClause AS CHARACTER NO-UNDO.
DEFINE VARIABLE limitNumber AS DECIMAL NO-UNDO.
DEFINE VARIABLE limitValue AS INT64 NO-UNDO.
DEFINE VARIABLE fieldNames AS CHARACTER NO-UNDO.
DEFINE VARIABLE lobNames AS CHARACTER NO-UNDO.
DEFINE VARIABLE effectiveFields AS CHARACTER NO-UNDO.
DEFINE VARIABLE queryString AS CHARACTER NO-UNDO.
DEFINE VARIABLE queryPrepared AS LOGICAL NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE hField AS HANDLE NO-UNDO.
DEFINE VARIABLE hLobFields AS HANDLE EXTENT NO-UNDO.
DEFINE VARIABLE lobCount AS INTEGER NO-UNDO.
DEFINE VARIABLE mLob AS MEMPTR NO-UNDO.
DEFINE VARIABLE requestStart AS INT64 NO-UNDO.
DEFINE VARIABLE passCount AS INTEGER NO-UNDO.
DEFINE VARIABLE recordCounter AS INT64 NO-UNDO.
DEFINE VARIABLE fieldIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE fieldName AS CHARACTER NO-UNDO.

/* Reads an optional JSON array of field names as a de-duplicated comma list. Returns ? when
   the value is not an array of non-empty names (names never contain commas or blanks). */
FUNCTION readNameList RETURNS CHARACTER (INPUT pKey AS CHARACTER):
  DEFINE VARIABLE names AS JsonArray NO-UNDO.
  DEFINE VARIABLE nameList AS CHARACTER NO-UNDO.
  DEFINE VARIABLE entryIndex AS INTEGER NO-UNDO.
  DEFINE VARIABLE entryName AS CHARACTER NO-UNDO.
  IF NOT payload:Has(pKey) OR payload:IsNull(pKey) THEN RETURN "".
  IF payload:GetType(pKey) <> JsonDataType:ARRAY THEN RETURN ?.
  names = payload:GetJsonArray(pKey).
  DO entryIndex = 1 TO names:Length:
    IF names:GetType(entryIndex) <> JsonDataType:STRING THEN RETURN ?.
    entryName = TRIM(names:GetCharacter(entryIndex)).
    IF entryName = "" OR INDEX(entryName, ",") > 0 OR INDEX(entryName, " ") > 0 THEN RETURN ?.
    IF LOOKUP(entryName, nameList) = 0 THEN
      nameList = nameList + (IF nameList = "" THEN "" ELSE ",") + entryName.
  END.
  RETURN nameList.
END FUNCTION.

/* Dynamic objects live in this procedure's pool, so they are released even when the
   handler's STOP-AFTER interrupts a pass. */
CREATE WIDGET-POOL.

parser = NEW ObjectModelParser().
ASSIGN payload = CAST(parser:Parse(SingleParam), JsonObject) NO-ERROR.
IF ERROR-STATUS:ERROR OR NOT VALID-OBJECT(payload) THEN RETURN ERROR "invalid_work_input:input".

IF payload:Has("mode") AND payload:GetType("mode") = JsonDataType:STRING THEN
  workMode = payload:GetCharacter("mode").
IF workMode <> "run" AND workMode <> "validate" THEN RETURN ERROR "invalid_work_mode".

/* Parameter types. */
IF NOT payload:Has("TableName") OR payload:IsNull("TableName") THEN
  RETURN ERROR "arbitrary_reads_invalid:table:".
IF payload:GetType("TableName") <> JsonDataType:STRING THEN
  RETURN ERROR "invalid_work_input:TableName".
tableName = TRIM(payload:GetCharacter("TableName")).
IF tableName = "" THEN RETURN ERROR "arbitrary_reads_invalid:table:".

IF payload:Has("WhereClause") AND NOT payload:IsNull("WhereClause") THEN DO:
  IF payload:GetType("WhereClause") <> JsonDataType:STRING THEN
    RETURN ERROR "invalid_work_input:WhereClause".
  whereClause = TRIM(payload:GetCharacter("WhereClause")).
  /* A leading WHERE keyword is optional. */
  IF whereClause = "WHERE" THEN
    whereClause = "".
  ELSE IF LENGTH(whereClause) > 5 AND SUBSTRING(whereClause, 1, 5) = "WHERE" AND
          INDEX(" ~t~n~r", SUBSTRING(whereClause, 6, 1)) > 0 THEN
    whereClause = TRIM(SUBSTRING(whereClause, 6)).
END.

IF payload:Has("Limit") AND NOT payload:IsNull("Limit") THEN DO:
  IF payload:GetType("Limit") <> JsonDataType:NUMBER THEN RETURN ERROR "invalid_work_input:Limit".
  ASSIGN limitNumber = payload:GetDecimal("Limit") NO-ERROR.
  IF ERROR-STATUS:ERROR OR limitNumber = ? OR limitNumber <> TRUNCATE(limitNumber, 0) THEN
    RETURN ERROR "invalid_work_input:Limit".
  limitValue = INT64(limitNumber).
END.

fieldNames = readNameList("FieldsList").
IF fieldNames = ? THEN RETURN ERROR "invalid_work_input:FieldsList".
lobNames = readNameList("LobFields").
IF lobNames = ? THEN RETURN ERROR "invalid_work_input:LobFields".

/* Table: application tables only. */
FIND FIRST _File NO-LOCK
  WHERE _File._File-Name = tableName AND _File._Tbl-Type = "T" NO-ERROR.
IF NOT AVAILABLE _File THEN RETURN ERROR "arbitrary_reads_invalid:table:" + tableName.
CREATE BUFFER hBuffer FOR TABLE _File._File-Name NO-ERROR.
IF NOT VALID-HANDLE(hBuffer) THEN RETURN ERROR "arbitrary_reads_invalid:table:" + tableName.

/* Fields: FieldsList first, then any LobFields it does not already name. */
DO fieldIndex = 1 TO NUM-ENTRIES(fieldNames):
  fieldName = ENTRY(fieldIndex, fieldNames).
  hField = ?.
  ASSIGN hField = hBuffer:BUFFER-FIELD(fieldName) NO-ERROR.
  IF NOT VALID-HANDLE(hField) THEN RETURN ERROR "arbitrary_reads_invalid:field:" + fieldName.
  IF LOOKUP(hField:NAME, effectiveFields) = 0 THEN
    effectiveFields = effectiveFields + (IF effectiveFields = "" THEN "" ELSE ",") + hField:NAME.
END.
lobCount = NUM-ENTRIES(lobNames).
IF lobCount > 0 THEN EXTENT(hLobFields) = lobCount.
DO fieldIndex = 1 TO lobCount:
  fieldName = ENTRY(fieldIndex, lobNames).
  hField = ?.
  ASSIGN hField = hBuffer:BUFFER-FIELD(fieldName) NO-ERROR.
  IF NOT VALID-HANDLE(hField) THEN RETURN ERROR "arbitrary_reads_invalid:field:" + fieldName.
  IF hField:DATA-TYPE <> "BLOB" AND hField:DATA-TYPE <> "CLOB" THEN
    RETURN ERROR "arbitrary_reads_invalid:lob_field:" + fieldName.
  hLobFields[fieldIndex] = hField.
  IF LOOKUP(hField:NAME, effectiveFields) = 0 THEN
    effectiveFields = effectiveFields + (IF effectiveFields = "" THEN "" ELSE ",") + hField:NAME.
END.

/* Query: FOR EACH <table> [FIELDS (...)] [WHERE <condition>] NO-LOCK. */
queryString = "FOR EACH " + hBuffer:NAME.
IF fieldNames <> "" THEN
  queryString = queryString + " FIELDS (" + REPLACE(effectiveFields, ",", " ") + ")".
IF whereClause <> "" THEN queryString = queryString + " WHERE " + whereClause.
queryString = queryString + " NO-LOCK".
CREATE QUERY hQuery.
hQuery:SET-BUFFERS(hBuffer).
ASSIGN queryPrepared = hQuery:QUERY-PREPARE(queryString) NO-ERROR.
IF ERROR-STATUS:ERROR OR queryPrepared <> TRUE THEN
  RETURN ERROR "arbitrary_reads_invalid:where_clause".

IF workMode = "validate" THEN RETURN.

requestStart = ETIME.
DO WHILE passCount = 0 OR ETIME - requestStart < 1000:
  RUN performArbitraryRead.
  passCount = passCount + 1.
END.

CATCH readError AS Progress.Lang.Error:
  /* Codes raised on purpose (RETURN ERROR in performArbitraryRead) keep their text. */
  IF TYPE-OF(readError, Progress.Lang.AppError) AND
     CAST(readError, Progress.Lang.AppError):ReturnValue > "" THEN
    RETURN ERROR CAST(readError, Progress.Lang.AppError):ReturnValue.
  RETURN ERROR "arbitrary_reads_failed:" + STRING(readError:GetMessageNum(1)).
END CATCH.

FINALLY:
  SET-SIZE(mLob) = 0.
  IF VALID-HANDLE(hQuery) THEN DO:
    IF hQuery:IS-OPEN THEN hQuery:QUERY-CLOSE().
    DELETE OBJECT hQuery.
  END.
  IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
END FINALLY.

/* One read pass: at most Limit records, each with its LOB fields fetched and released. */
PROCEDURE performArbitraryRead PRIVATE:
  DEFINE VARIABLE lobIndex AS INTEGER NO-UNDO.
  DEFINE VARIABLE lobUnknown AS LOGICAL NO-UNDO.
  DEFINE VARIABLE copyError AS INTEGER NO-UNDO.

  recordCounter = 0.
  hQuery:QUERY-OPEN().
  DO WHILE TRUE:
    hQuery:GET-NEXT().
    IF hQuery:QUERY-OFF-END THEN LEAVE.
    recordCounter = recordCounter + 1.
    IF limitValue > 0 AND recordCounter > limitValue THEN LEAVE.
    DO lobIndex = 1 TO lobCount:
      COPY-LOB FROM hLobFields[lobIndex]:BUFFER-VALUE TO mLob NO-ERROR.
      IF ERROR-STATUS:ERROR THEN DO:
        copyError = ERROR-STATUS:GET-NUMBER(1).
        lobUnknown = FALSE.
        lobUnknown = (? = hLobFields[lobIndex]:BUFFER-VALUE) NO-ERROR.
        IF lobUnknown <> TRUE THEN RETURN ERROR "arbitrary_reads_failed:" + STRING(copyError).
      END.
      SET-SIZE(mLob) = 0.
    END.
  END.
  hQuery:QUERY-CLOSE().
END PROCEDURE.
