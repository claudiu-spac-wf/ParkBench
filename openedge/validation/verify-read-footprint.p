/* Independent bracket verifier: a single separate <=N traversal computes both
   selected and previous-cutoff totals directly, without consulting histograms. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE profile AS JsonObject NO-UNDO.
DEFINE VARIABLE tables AS JsonArray NO-UNDO.
DEFINE VARIABLE spec AS JsonObject NO-UNDO.
DEFINE VARIABLE lobs AS JsonArray NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE hField AS HANDLE NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE tableIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE fieldIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE cutoff AS INTEGER NO-UNDO.
DEFINE VARIABLE bucketNumber AS INTEGER NO-UNDO.
DEFINE VARIABLE rowBytes AS INT64 NO-UNDO.
DEFINE VARIABLE selectedBytes AS INT64 NO-UNDO.
DEFINE VARIABLE previousBytes AS INT64 NO-UNDO.
CREATE WIDGET-POOL.
parser = NEW ObjectModelParser(). config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
profile = CAST(parser:ParseFile(config:GetCharacter("profile")), JsonObject).
tables = profile:GetJsonArray("tables"). cutoff = config:GetInteger("cutoff").
DO tableIndex = 1 TO tables:Length:
  spec = tables:GetJsonObject(tableIndex). lobs = spec:GetJsonArray("requestedLobFields").
  CREATE BUFFER hBuffer FOR TABLE spec:GetCharacter("name"). CREATE QUERY hQuery. hQuery:SET-BUFFERS(hBuffer).
  IF hQuery:QUERY-PREPARE("FOR EACH " + hBuffer:NAME + " WHERE RandomInt1000 <= " + STRING(cutoff) + " NO-LOCK") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN
    UNDO, THROW NEW Progress.Lang.AppError("read_bracket_query_failed", 0).
  REPEAT:
    hQuery:GET-NEXT(). IF hQuery:QUERY-OFF-END THEN LEAVE.
    bucketNumber = INTEGER(hBuffer:BUFFER-FIELD("RandomInt1000"):BUFFER-VALUE).
    IF bucketNumber = ? OR bucketNumber < 1 OR bucketNumber > cutoff THEN UNDO, THROW NEW Progress.Lang.AppError("read_bracket_bucket_invalid", 0).
    rowBytes = hBuffer:RECORD-LENGTH.
    DO fieldIndex = 1 TO lobs:Length:
      hField = hBuffer:BUFFER-FIELD(lobs:GetCharacter(fieldIndex)). SET-SIZE(memoryValue) = 0.
      IF hField:BUFFER-VALUE <> ? THEN DO:
        COPY-LOB FROM hField:BUFFER-VALUE TO memoryValue NO-CONVERT.
        rowBytes = rowBytes + GET-SIZE(memoryValue).
      END.
      SET-SIZE(memoryValue) = 0.
    END.
    selectedBytes = selectedBytes + rowBytes.
    IF bucketNumber < cutoff THEN previousBytes = previousBytes + rowBytes.
  END.
  hQuery:QUERY-CLOSE(). DELETE OBJECT hQuery. DELETE OBJECT hBuffer.
END.
result = NEW JsonObject(). result:Add("ok", TRUE).
result:Add("selectedBytes", selectedBytes). result:Add("previousCutoffBytes", previousBytes).
result:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
FINALLY:
  SET-SIZE(memoryValue) = 0.
END FINALLY.
