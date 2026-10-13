/* Test-only loader for independent fixtures in a disposable schema-only DB.
   The live database is authoritative for current records and candidate availability. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE fixture AS JsonObject NO-UNDO.
DEFINE VARIABLE tableValue AS JsonObject NO-UNDO.
DEFINE VARIABLE rowValue AS JsonObject NO-UNDO.
DEFINE VARIABLE lobValue AS JsonObject NO-UNDO.
DEFINE VARIABLE tables AS JsonArray NO-UNDO.
DEFINE VARIABLE rows AS JsonArray NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hField AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE textValue AS LONGCHAR NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE i AS INTEGER NO-UNDO.
DEFINE VARIABLE j AS INTEGER NO-UNDO.
DEFINE VARIABLE k AS INTEGER NO-UNDO.
DEFINE VARIABLE ignoredId AS INT64 NO-UNDO.
DEFINE VARIABLE valueText AS CHARACTER NO-UNDO.
DEFINE VARIABLE dateValue AS DATE NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_disposable_database_required", 0).
parser = NEW ObjectModelParser().
config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
IF config:GetCharacter("command") = "dump-schema" THEN DO:
  RUN prodict/dump_df.p ("ALL", config:GetCharacter("output"), "").
  QUIT.
END.
IF config:GetCharacter("command") <> "populate" THEN
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_command_invalid", 0).
fixture = CAST(parser:ParseFile(config:GetCharacter("data")), JsonObject).
tables = fixture:GetJsonArray("tables").
CREATE WIDGET-POOL.
DO ON ERROR UNDO, THROW:
  DO i = 1 TO tables:Length:
    tableValue = tables:GetJsonObject(i).
    tableName = tableValue:GetCharacter("name").
    rows = tableValue:GetJsonArray("rows").
    CREATE BUFFER hBuffer FOR TABLE tableName.
    CREATE QUERY hQuery.
    IF hQuery:SET-BUFFERS(hBuffer) <> TRUE OR
      hQuery:QUERY-PREPARE("FOR EACH " + tableName + " NO-LOCK") <> TRUE OR
      hQuery:QUERY-OPEN() <> TRUE THEN
      UNDO, THROW NEW Progress.Lang.AppError("write_fixture_query_failed", 0).
    hQuery:GET-FIRST().
    IF hBuffer:AVAILABLE THEN UNDO, THROW NEW Progress.Lang.AppError("write_fixture_database_not_empty", 0).
    hQuery:QUERY-CLOSE().
    DELETE OBJECT hQuery.
    DO TRANSACTION ON ERROR UNDO, THROW:
      DO j = 1 TO rows:Length:
        rowValue = rows:GetJsonObject(j).
        IF hBuffer:BUFFER-CREATE() <> TRUE THEN
          UNDO, THROW NEW Progress.Lang.AppError("write_fixture_create_failed", 0).
        DO k = 1 TO hBuffer:NUM-FIELDS:
          hField = hBuffer:BUFFER-FIELD(k).
          IF tableName = "StatementDocument" AND hField:NAME = "StatementXml" THEN NEXT.
          IF NOT rowValue:Has(hField:NAME) THEN
            UNDO, THROW NEW Progress.Lang.AppError("write_fixture_field_missing:" + tableName + "." + hField:NAME, 0).
          CASE hField:DATA-TYPE:
            WHEN "CHARACTER" THEN hField:BUFFER-VALUE = rowValue:GetCharacter(hField:NAME).
            WHEN "INTEGER" THEN hField:BUFFER-VALUE = rowValue:GetInteger(hField:NAME).
            WHEN "INT64" THEN hField:BUFFER-VALUE = rowValue:GetInt64(hField:NAME).
            WHEN "DECIMAL" THEN hField:BUFFER-VALUE = rowValue:GetDecimal(hField:NAME).
            WHEN "LOGICAL" THEN hField:BUFFER-VALUE = rowValue:GetLogical(hField:NAME).
            WHEN "DATE" THEN DO:
              valueText = rowValue:GetCharacter(hField:NAME).
              hField:BUFFER-VALUE = DATE(INTEGER(SUBSTRING(valueText, 6, 2)), INTEGER(SUBSTRING(valueText, 9, 2)), INTEGER(SUBSTRING(valueText, 1, 4))).
            END.
            WHEN "DATETIME" OR WHEN "DATETIME-TZ" THEN DO:
              valueText = rowValue:GetCharacter(hField:NAME).
              dateValue = DATE(INTEGER(SUBSTRING(valueText, 6, 2)), INTEGER(SUBSTRING(valueText, 9, 2)), INTEGER(SUBSTRING(valueText, 1, 4))).
              IF hField:DATA-TYPE = "DATETIME" THEN hField:BUFFER-VALUE = DATETIME(dateValue, 45000000).
              ELSE hField:BUFFER-VALUE = DATETIME-TZ(dateValue, 45000000, 0).
            END.
            WHEN "BLOB" OR WHEN "CLOB" THEN DO:
              lobValue = rowValue:GetJsonObject(hField:NAME).
              textValue = "".
              DO WHILE LENGTH(textValue) < lobValue:GetInteger("bytes"):
                textValue = textValue + lobValue:GetCharacter("pattern").
              END.
              textValue = SUBSTRING(textValue, 1, lobValue:GetInteger("bytes")).
              COPY-LOB FROM textValue TO memoryValue CONVERT TARGET CODEPAGE "UTF-8".
              IF GET-SIZE(memoryValue) <> lobValue:GetInteger("bytes") THEN
                UNDO, THROW NEW Progress.Lang.AppError("write_fixture_lob_size_failed", 0).
              IF tableName = "StatementDocument" THEN DO:
                lobValue = rowValue:GetJsonObject("StatementXml").
                textValue = "".
                DO WHILE LENGTH(textValue) < lobValue:GetInteger("bytes"):
                  textValue = textValue + lobValue:GetCharacter("pattern").
                END.
                textValue = SUBSTRING(textValue, 1, lobValue:GetInteger("bytes")).
                /* One ASSIGN initializes both mandatory fields before either
                   dynamic COPY-LOB target could flush an incomplete record. */
                ASSIGN hBuffer:BUFFER-FIELD("PdfContent"):BUFFER-VALUE = memoryValue
                  hBuffer:BUFFER-FIELD("StatementXml"):BUFFER-VALUE = textValue.
              END.
              ELSE COPY-LOB FROM memoryValue TO hField:BUFFER-VALUE.
              SET-SIZE(memoryValue) = 0.
              textValue = "".
            END.
            OTHERWISE UNDO, THROW NEW Progress.Lang.AppError("write_fixture_type_unhandled", 0).
          END CASE.
        END.
        IF hBuffer:BUFFER-VALIDATE() <> TRUE THEN
          UNDO, THROW NEW Progress.Lang.AppError("write_fixture_invalid:" + tableName, 0).
        hBuffer:BUFFER-RELEASE().
        ignoredId = DYNAMIC-NEXT-VALUE("Seq" + tableName + "Id", "parkbench").
      END.
    END.
    DELETE OBJECT hBuffer.
  END.
  result = NEW JsonObject().
  result:Add("ok", TRUE).
  result:Add("tables", tables:Length).
  result:Add("variant", fixture:GetCharacter("variant")).
  result:WriteFile(config:GetCharacter("report"), TRUE).
  FINALLY:
    SET-SIZE(memoryValue) = 0.
    IF VALID-HANDLE(hQuery) THEN DELETE OBJECT hQuery.
    IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
  END FINALLY.
END.
QUIT.
