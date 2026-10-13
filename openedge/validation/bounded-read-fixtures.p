/* Native complete-domain oracle plus unchanged production workload execution.
   Only disposable fixture databases may be inspected by this driver. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE operations AS JsonArray NO-UNDO.
DEFINE VARIABLE operation AS JsonObject NO-UNDO.
DEFINE VARIABLE inputValue AS JsonObject NO-UNDO.
DEFINE VARIABLE entries AS JsonArray NO-UNDO.
DEFINE VARIABLE entryValue AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE payload AS LONGCHAR NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
DEFINE VARIABLE hLob AS HANDLE NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE lobs AS JsonArray NO-UNDO.
DEFINE VARIABLE opIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE lobIndex AS INTEGER NO-UNDO.
DEFINE VARIABLE band AS INTEGER NO-UNDO.
DEFINE VARIABLE cutoff AS INTEGER NO-UNDO.
DEFINE VARIABLE rows AS INT64 NO-UNDO.
DEFINE VARIABLE totalRows AS INT64 NO-UNDO.
DEFINE VARIABLE largestRows AS INT64 NO-UNDO.
DEFINE VARIABLE largestBand AS INTEGER NO-UNDO.
DEFINE VARIABLE emptyBuckets AS INTEGER NO-UNDO.
DEFINE VARIABLE lobBytes AS INT64 NO-UNDO.
DEFINE VARIABLE beforeReads AS INT64 NO-UNDO.
DEFINE VARIABLE afterReads AS INT64 NO-UNDO.
DEFINE VARIABLE began AS INTEGER NO-UNDO.
DEFINE VARIABLE tableNumber AS INTEGER NO-UNDO.
DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
DEFINE VARIABLE whereText AS CHARACTER NO-UNDO.
DEFINE VARIABLE bandToken AS CHARACTER NO-UNDO.
DEFINE VARIABLE finishedRead AS LOGICAL NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_read_fixture_required", 0).
parser = NEW ObjectModelParser(). config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
operations = config:GetJsonArray("operations"). cutoff = config:GetInteger("cutoff"). entries = NEW JsonArray().
bandToken = CHR(123) + CHR(123) + "band" + CHR(125) + CHR(125).
DO TRANSACTION:
  FIND FIRST Account EXCLUSIVE-LOCK.
  Account.RandomInt1000 = cutoff + 1.
END.
DO opIndex = 1 TO operations:Length:
  operation = operations:GetJsonObject(opIndex). inputValue = operation:GetJsonObject("bodyTemplate"):GetJsonObject("input").
  tableName = inputValue:GetCharacter("TableName").
  FIND FIRST _File NO-LOCK WHERE _File._File-Name = tableName.
  tableNumber = _File._File-Number.
  CREATE BUFFER hBuffer FOR TABLE tableName. CREATE QUERY hQuery. hQuery:SET-BUFFERS(hBuffer).
  ASSIGN totalRows = 0 largestRows = -1 largestBand = 1 emptyBuckets = 0 lobBytes = 0.
  DO band = 1 TO cutoff:
    whereText = REPLACE(inputValue:GetCharacter("WhereClause"), bandToken, STRING(band)).
    IF hQuery:QUERY-PREPARE("FOR EACH " + tableName + " WHERE " + whereText + " NO-LOCK") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN
      UNDO, THROW NEW Progress.Lang.AppError("bounded_read_query_failed", 0).
    rows = 0.
    REPEAT:
      hQuery:GET-NEXT(). IF hQuery:QUERY-OFF-END THEN LEAVE.
      IF INTEGER(hBuffer:BUFFER-FIELD("RandomInt1000"):BUFFER-VALUE) <> band THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_read_domain_failed", 0).
      rows = rows + 1.
      IF inputValue:Has("LobFields") THEN DO:
        lobs = inputValue:GetJsonArray("LobFields").
        DO lobIndex = 1 TO lobs:Length:
          hLob = hBuffer:BUFFER-FIELD(lobs:GetCharacter(lobIndex)). SET-SIZE(memoryValue) = 0.
          IF hLob:BUFFER-VALUE <> ? THEN COPY-LOB FROM hLob:BUFFER-VALUE TO memoryValue NO-CONVERT.
          lobBytes = lobBytes + GET-SIZE(memoryValue). SET-SIZE(memoryValue) = 0.
        END.
      END.
    END.
    hQuery:QUERY-CLOSE(). totalRows = totalRows + rows.
    IF rows = 0 THEN emptyBuckets = emptyBuckets + 1.
    IF rows > largestRows THEN ASSIGN largestRows = rows largestBand = band.
  END.
  DELETE OBJECT hQuery. DELETE OBJECT hBuffer.
  FIND FIRST _TableStat NO-LOCK WHERE _TableStat._TableStat-Id = tableNumber.
  beforeReads = _TableStat._TableStat-Read.
  whereText = REPLACE(inputValue:GetCharacter("WhereClause"), bandToken, STRING(largestBand)).
  inputValue:Set("WhereClause", whereText). inputValue:Write(payload). began = ETIME.
  finishedRead = FALSE.
  DO STOP-AFTER 60 ON STOP UNDO, LEAVE ON ERROR UNDO, THROW:
    RUN Workloads/Generic/arbitrary_reads.r (payload).
    finishedRead = TRUE.
  END.
  IF NOT finishedRead THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_read_deadline", 0).
  FIND FIRST _TableStat NO-LOCK WHERE _TableStat._TableStat-Id = tableNumber.
  afterReads = _TableStat._TableStat-Read.
  IF afterReads - beforeReads < largestRows THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_read_incomplete_native_pass", 0).
  entryValue = NEW JsonObject(). entryValue:Add("operationId", operation:GetCharacter("id")).
  entryValue:Add("admittedBuckets", cutoff). entryValue:Add("eligibleRows", totalRows).
  entryValue:Add("emptyBuckets", emptyBuckets). entryValue:Add("requestedLobBytes", lobBytes).
  entryValue:Add("largestBand", largestBand). entryValue:Add("largestRows", largestRows).
  entryValue:Add("actualWorkloadReads", afterReads - beforeReads). entryValue:Add("elapsedMs", ETIME - began).
  /* Exercise the same compiled workload with an above-cutoff band. The
     disposable fixture includes an Account row in this excluded bucket. */
  beforeReads = afterReads.
  inputValue:Set("WhereClause", "RandomInt1000 <= " + STRING(cutoff) + " AND RandomInt1000 = " + STRING(cutoff + 1)).
  inputValue:Write(payload). finishedRead = FALSE.
  DO STOP-AFTER 60 ON STOP UNDO, LEAVE ON ERROR UNDO, THROW:
    RUN Workloads/Generic/arbitrary_reads.r (payload).
    finishedRead = TRUE.
  END.
  IF NOT finishedRead THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_excluded_read_deadline", 0).
  FIND FIRST _TableStat NO-LOCK WHERE _TableStat._TableStat-Id = tableNumber.
  /* _TableStat counts engine candidates examined as well as matched rows.
     An empty predicate can still inspect records; it is not a result-row count. */
  entryValue:Add("aboveCutoffEngineReads", _TableStat._TableStat-Read - beforeReads).
  CREATE BUFFER hBuffer FOR TABLE tableName. CREATE QUERY hQuery. hQuery:SET-BUFFERS(hBuffer).
  IF hQuery:QUERY-PREPARE("FOR EACH " + tableName + " WHERE " + inputValue:GetCharacter("WhereClause") + " NO-LOCK") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN
    UNDO, THROW NEW Progress.Lang.AppError("bounded_excluded_query_failed", 0).
  hQuery:GET-NEXT().
  IF NOT hQuery:QUERY-OFF-END THEN UNDO, THROW NEW Progress.Lang.AppError("bounded_above_cutoff_match", 0).
  entryValue:Add("aboveCutoffMatchedRows", 0).
  hQuery:QUERY-CLOSE(). DELETE OBJECT hQuery. DELETE OBJECT hBuffer.
  entries:Add(entryValue).
END.
result = NEW JsonObject(). result:Add("ok", TRUE). result:Add("cases", entries).
result:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
FINALLY:
  SET-SIZE(memoryValue) = 0.
END FINALLY.
