/* Offline authoring probe. NO-LOCK scans and requested external payload union;
   record bytes include locators, external payload bytes are counted once.
   https://docs.progress.com/bundle/openedge-abl-reference-128/page/RECORD-LENGTH-attribute.html
   https://docs.progress.com/bundle/openedge-abl-reference-128/page/COPY-LOB-statement.html */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE profile AS JsonObject NO-UNDO.
DEFINE VARIABLE tables AS JsonArray NO-UNDO.
DEFINE VARIABLE tableSpec AS JsonObject NO-UNDO.
DEFINE VARIABLE lobFields AS JsonArray NO-UNDO.
DEFINE VARIABLE outputValue AS JsonObject NO-UNDO.
DEFINE VARIABLE outputTables AS JsonArray NO-UNDO.
DEFINE VARIABLE outputTable AS JsonObject NO-UNDO.
DEFINE VARIABLE buckets AS JsonArray NO-UNDO.
DEFINE VARIABLE bucketValue AS JsonObject NO-UNDO.
DEFINE VARIABLE schemaTables AS JsonArray NO-UNDO.
DEFINE VARIABLE schemaTable AS JsonObject NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE hField AS HANDLE NO-UNDO.
DEFINE VARIABLE hBucket AS HANDLE NO-UNDO.
DEFINE VARIABLE mLob AS MEMPTR NO-UNDO.
DEFINE VARIABLE bucketNumber AS INTEGER NO-UNDO.
DEFINE VARIABLE tableIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE lobIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE i AS INTEGER NO-UNDO.
DEFINE VARIABLE cutoff AS INTEGER INITIAL 1000 NO-UNDO.
DEFINE VARIABLE rowCounts AS INT64 EXTENT 1000 NO-UNDO.
DEFINE VARIABLE recordBytes AS INT64 EXTENT 1000 NO-UNDO.
DEFINE VARIABLE lobBytes AS INT64 EXTENT 1000 NO-UNDO.
DEFINE VARIABLE currentLobBytes AS INT64 NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE queryText AS CHARACTER NO-UNDO.
CREATE WIDGET-POOL.
parser = NEW ObjectModelParser().
config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
profile = CAST(parser:ParseFile(config:GetCharacter("profile")), JsonObject).
tables = profile:GetJsonArray("tables").
outputValue = NEW JsonObject(). outputTables = NEW JsonArray(). schemaTables = NEW JsonArray().
/* Schema CRC is native and stable across disposable copies. Export every user
   table rather than hashing timestamp-bearing dump-file comments. */
FOR EACH _File NO-LOCK WHERE _File._Tbl-Type = "T" AND _File._File-Number > 0 BY _File._File-Name:
  schemaTable = NEW JsonObject().
  schemaTable:Add("name", _File._File-Name). schemaTable:Add("crc", _File._CRC).
  schemaTables:Add(schemaTable).
END.
outputValue:Add("schema", schemaTables).
IF config:Has("schemaOnly") AND config:GetLogical("schemaOnly") THEN DO:
  outputValue:Add("ok", TRUE). outputValue:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
END.
IF config:Has("cutoff") THEN cutoff = config:GetInteger("cutoff").
IF cutoff < 0 OR cutoff > 1000 THEN UNDO, THROW NEW Progress.Lang.AppError("read_cutoff_invalid", 0).
DO tableIndex = 1 TO tables:Length:
  tableSpec = tables:GetJsonObject(tableIndex). tableName = tableSpec:GetCharacter("name").
  lobFields = tableSpec:GetJsonArray("requestedLobFields").
  DO i = 1 TO 1000: ASSIGN rowCounts[i] = 0 recordBytes[i] = 0 lobBytes[i] = 0. END.
  CREATE BUFFER hBuffer FOR TABLE tableName. CREATE QUERY hQuery. hQuery:SET-BUFFERS(hBuffer).
  hBucket = hBuffer:BUFFER-FIELD("RandomInt1000").
  DO lobIndex = 1 TO lobFields:Length:
    hField = hBuffer:BUFFER-FIELD(lobFields:GetCharacter(lobIndex)).
    IF hField:DATA-TYPE <> "BLOB" AND hField:DATA-TYPE <> "CLOB" THEN
      UNDO, THROW NEW Progress.Lang.AppError("read_profile_lob_type_invalid", 0).
  END.
  queryText = "FOR EACH " + tableName.
  IF cutoff < 1000 THEN queryText = queryText + " WHERE RandomInt1000 <= " + STRING(cutoff).
  queryText = queryText + " NO-LOCK".
  IF hQuery:QUERY-PREPARE(queryText) <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN
    UNDO, THROW NEW Progress.Lang.AppError("read_footprint_query_failed", 0).
  REPEAT:
    hQuery:GET-NEXT(). IF hQuery:QUERY-OFF-END THEN LEAVE.
    IF hBucket:BUFFER-VALUE = ? THEN UNDO, THROW NEW Progress.Lang.AppError("read_bucket_unknown", 0).
    bucketNumber = INTEGER(hBucket:BUFFER-VALUE).
    IF bucketNumber < 1 OR bucketNumber > 1000 THEN UNDO, THROW NEW Progress.Lang.AppError("read_bucket_out_of_range", 0).
    ASSIGN rowCounts[bucketNumber] = rowCounts[bucketNumber] + 1
      recordBytes[bucketNumber] = recordBytes[bucketNumber] + hBuffer:RECORD-LENGTH.
    DO lobIndex = 1 TO lobFields:Length:
      hField = hBuffer:BUFFER-FIELD(lobFields:GetCharacter(lobIndex)).
      SET-SIZE(mLob) = 0.
      IF hField:BUFFER-VALUE <> ? THEN DO:
        COPY-LOB FROM hField:BUFFER-VALUE TO mLob NO-CONVERT.
        currentLobBytes = GET-SIZE(mLob).
        IF currentLobBytes < 0 THEN UNDO, THROW NEW Progress.Lang.AppError("read_lob_size_invalid", 0).
        lobBytes[bucketNumber] = lobBytes[bucketNumber] + currentLobBytes.
      END.
      SET-SIZE(mLob) = 0.
    END.
  END.
  hQuery:QUERY-CLOSE(). DELETE OBJECT hQuery. DELETE OBJECT hBuffer.
  outputTable = NEW JsonObject(). buckets = NEW JsonArray().
  outputTable:Add("name", tableName). outputTable:Add("requestedLobFields", lobFields).
  outputTable:Add("lobEncoding", "stored bytes; COPY-LOB NO-CONVERT; native schema verified").
  DO i = 1 TO 1000:
    bucketValue = NEW JsonObject(). bucketValue:Add("bucket", i). bucketValue:Add("rowCount", rowCounts[i]).
    bucketValue:Add("recordBytes", recordBytes[i]). bucketValue:Add("lobBytes", lobBytes[i]).
    bucketValue:Add("totalBytes", recordBytes[i] + lobBytes[i]). buckets:Add(bucketValue).
  END.
  outputTable:Add("buckets", buckets). outputTables:Add(outputTable).
  MESSAGE "read_footprint_table_complete:" tableName.
END.
outputValue:Add("tables", outputTables). outputValue:Add("ok", TRUE).
outputValue:WriteFile(config:GetCharacter("report"), TRUE).
QUIT.
FINALLY:
  SET-SIZE(mLob) = 0.
END FINALLY.
