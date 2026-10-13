/* Read-only snapshot driver. Hashes all LOB bytes, preserves unknown markers,
   and records sequences without advancing them. Other case drivers reuse it. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE allOutput AS JsonObject NO-UNDO.
DEFINE VARIABLE requestedTables AS JsonArray NO-UNDO.
DEFINE VARIABLE tableIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE outputValue AS JsonObject NO-UNDO.
DEFINE VARIABLE rowValue AS JsonObject NO-UNDO.
DEFINE VARIABLE lobValue AS JsonObject NO-UNDO.
DEFINE VARIABLE rows AS JsonArray NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE hField AS HANDLE NO-UNDO.
DEFINE VARIABLE fieldIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE clause AS CHARACTER NO-UNDO.
DEFINE VARIABLE requireKnown AS LOGICAL NO-UNDO.
DEFINE VARIABLE inventory AS JsonObject NO-UNDO.
DEFINE VARIABLE descriptors AS JsonArray NO-UNDO.
DEFINE VARIABLE fieldDescriptors AS JsonArray NO-UNDO.
DEFINE VARIABLE descriptor AS JsonObject NO-UNDO.
DEFINE VARIABLE relationship AS JsonObject NO-UNDO.
DEFINE VARIABLE parentBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE parentQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE indexValue AS INTEGER NO-UNDO.
DEFINE VARIABLE valueText AS CHARACTER NO-UNDO.
DEFINE VARIABLE dateValue AS DATE NO-UNDO.
parser = NEW ObjectModelParser().
config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
requestedTables = NEW JsonArray().
IF config:Has("tables") THEN requestedTables = config:GetJsonArray("tables").
ELSE requestedTables:Add(config:GetCharacter("table")).
allOutput = NEW JsonObject().
clause = IF config:Has("where") THEN config:GetCharacter("where") ELSE "TRUE".
IF config:Has("requireKnown") THEN requireKnown = config:GetLogical("requireKnown").
IF config:Has("inventory") THEN DO:
  inventory = CAST(parser:ParseFile(config:GetCharacter("inventory")), JsonObject).
  descriptors = inventory:GetJsonArray("tables").
END.
CREATE WIDGET-POOL.
DO tableIndex = 1 TO requestedTables:Length:
  tableName = requestedTables:GetCharacter(tableIndex).
  fieldDescriptors = ?.
  IF VALID-OBJECT(descriptors) THEN DO:
  DO indexValue = 1 TO descriptors:Length:
    descriptor = descriptors:GetJsonObject(indexValue).
    IF descriptor:GetCharacter("name") = tableName THEN DO:
      fieldDescriptors = descriptor:GetJsonArray("fields").
      LEAVE.
    END.
  END.
  IF NOT VALID-OBJECT(fieldDescriptors) THEN UNDO, THROW NEW Progress.Lang.AppError("write_verify_table_missing", 0).
END.
DO ON ERROR UNDO, THROW:
  CREATE BUFFER hBuffer FOR TABLE tableName.
  CREATE QUERY hQuery.
  hQuery:SET-BUFFERS(hBuffer).
  IF hQuery:QUERY-PREPARE("FOR EACH " + tableName + " WHERE (" + clause + ") NO-LOCK BY " + tableName + "." + tableName + "Id") <> TRUE THEN
    UNDO, THROW NEW Progress.Lang.AppError("write_verify_query_failed", 0).
  rows = NEW JsonArray().
  hQuery:QUERY-OPEN().
  REPEAT:
    hQuery:GET-NEXT().
    IF hQuery:QUERY-OFF-END THEN LEAVE.
    rowValue = NEW JsonObject().
    rowValue:Add("$rowid", STRING(hBuffer:ROWID)).
    DO fieldIndex = 1 TO hBuffer:NUM-FIELDS:
      hField = hBuffer:BUFFER-FIELD(fieldIndex).
      IF requireKnown AND hField:DATA-TYPE <> "BLOB" AND hField:DATA-TYPE <> "CLOB"
        AND hField:BUFFER-VALUE = ? THEN
        UNDO, THROW NEW Progress.Lang.AppError("write_verify_unknown_ordinary:" + hField:NAME, 0).
      IF hField:BUFFER-VALUE = ? THEN rowValue:AddNull(hField:NAME).
      ELSE IF hField:DATA-TYPE = "BLOB" OR hField:DATA-TYPE = "CLOB" THEN DO:
        COPY-LOB FROM hField:BUFFER-VALUE TO memoryValue.
        lobValue = NEW JsonObject().
        lobValue:Add("bytes", GET-SIZE(memoryValue)).
        lobValue:Add("sha256", HEX-ENCODE(MESSAGE-DIGEST("SHA-256", memoryValue))).
        rowValue:Add(hField:NAME, lobValue).
        SET-SIZE(memoryValue) = 0.
      END.
      ELSE CASE hField:DATA-TYPE:
        WHEN "INTEGER" THEN rowValue:Add(hField:NAME, INTEGER(hField:BUFFER-VALUE)).
        WHEN "INT64" THEN rowValue:Add(hField:NAME, INT64(hField:BUFFER-VALUE)).
        WHEN "DECIMAL" THEN rowValue:Add(hField:NAME, DECIMAL(hField:BUFFER-VALUE)).
        WHEN "LOGICAL" THEN rowValue:Add(hField:NAME, LOGICAL(hField:BUFFER-VALUE)).
        WHEN "DATE" THEN DO:
          dateValue = hField:BUFFER-VALUE.
          rowValue:Add(hField:NAME, STRING(YEAR(dateValue), "9999") + "-" + STRING(MONTH(dateValue), "99") + "-" + STRING(DAY(dateValue), "99")).
        END.
        OTHERWISE rowValue:Add(hField:NAME, STRING(hField:BUFFER-VALUE)).
      END CASE.
    END.
    /* Assert actual parent existence natively, including sparse identifiers. */
    IF VALID-OBJECT(fieldDescriptors) THEN DO indexValue = 1 TO fieldDescriptors:Length:
      descriptor = fieldDescriptors:GetJsonObject(indexValue).
      IF NOT descriptor:Has("relationship") THEN NEXT.
      relationship = descriptor:GetJsonObject("relationship").
      hField = hBuffer:BUFFER-FIELD(descriptor:GetCharacter("name")).
      IF relationship:GetLogical("optional") AND hField:BUFFER-VALUE = 0 THEN NEXT.
      CREATE BUFFER parentBuffer FOR TABLE relationship:GetCharacter("parentTable").
      CREATE QUERY parentQuery.
      parentQuery:SET-BUFFERS(parentBuffer).
      valueText = STRING(hField:BUFFER-VALUE).
      IF hField:DATA-TYPE = "CHARACTER" THEN valueText = QUOTER(valueText).
      IF parentQuery:QUERY-PREPARE("FOR EACH " + relationship:GetCharacter("parentTable") + " WHERE "
        + relationship:GetCharacter("parentField") + " = " + valueText + " NO-LOCK") <> TRUE OR
        parentQuery:QUERY-OPEN() <> TRUE THEN UNDO, THROW NEW Progress.Lang.AppError("write_verify_parent_query_failed", 0).
      parentQuery:GET-FIRST().
      IF NOT parentBuffer:AVAILABLE THEN UNDO, THROW NEW Progress.Lang.AppError("write_verify_parent_missing:" + tableName + "." + hField:NAME, 0).
      parentQuery:QUERY-CLOSE().
      DELETE OBJECT parentQuery.
      DELETE OBJECT parentBuffer.
    END.
    rows:Add(rowValue).
  END.
  outputValue = NEW JsonObject().
  outputValue:Add("ok", TRUE).
  outputValue:Add("table", tableName).
  outputValue:Add("rows", rows).
  outputValue:Add("count", rows:Length).
  outputValue:Add("sequence", DYNAMIC-CURRENT-VALUE("Seq" + tableName + "Id", "parkbench")).
  allOutput:Add(tableName, outputValue).
  FINALLY:
    SET-SIZE(memoryValue) = 0.
    IF VALID-HANDLE(hQuery) THEN DELETE OBJECT hQuery.
    IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
    IF VALID-HANDLE(parentQuery) THEN DELETE OBJECT parentQuery.
    IF VALID-HANDLE(parentBuffer) THEN DELETE OBJECT parentBuffer.
  END FINALLY.
END.
END.
IF config:Has("tables") THEN allOutput:WriteFile(config:GetCharacter("report"), TRUE).
ELSE outputValue:WriteFile(config:GetCharacter("report"), TRUE).
QUIT.
