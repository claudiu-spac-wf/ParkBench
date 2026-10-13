USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonObject.


DEFINE VARIABLE payload AS JsonObject NO-UNDO.
DEFINE VARIABLE databaseIdentity AS JsonObject NO-UNDO.
DEFINE VARIABLE snapshot AS JsonObject NO-UNDO.
DEFINE VARIABLE sourceArray AS JsonArray NO-UNDO.
DEFINE VARIABLE unavailableSources AS JsonArray NO-UNDO.
DEFINE VARIABLE statusRows AS JsonArray NO-UNDO.
DEFINE VARIABLE statusRow AS JsonObject NO-UNDO.
DEFINE VARIABLE jsonText AS LONGCHAR NO-UNDO.
DEFINE VARIABLE sourcePresent AS LOGICAL NO-UNDO.
DEFINE VARIABLE outputOffset AS INTEGER NO-UNDO.
DEFINE VARIABLE outputLength AS INTEGER NO-UNDO.
DEFINE VARIABLE outputChunk AS CHARACTER NO-UNDO.
/* Protocol v3 preserves every supported table name. Unmapped VST range slots
   are not application tables; indexes retain their bounded label set. */
DEFINE VARIABLE indexLabels AS CHARACTER NO-UNDO.
DEFINE VARIABLE labelSets AS JsonObject NO-UNDO.

IF SESSION:PARAMETER = "parameter-capture" THEN DO:
  RUN captureParameterSnapshot.
  RETURN.
END.

RUN loadLabelSets.

/*
  Collect a bounded, read-only snapshot in one ABL process per scrape. The
  adapter converts this private snapshot into the validated OpenEdge DB v3
  metric contract and computes database_epoch. Dynamic buffers let 12.8
  patches report field-level capability without compile-time VST field names.
*/
payload = NEW JsonObject().
databaseIdentity = NEW JsonObject().
snapshot = NEW JsonObject().
unavailableSources = NEW JsonArray().

RUN captureSource(INPUT "_DbStatus",
  INPUT "_DbStatus-OEVersion,_DbStatus-starttime,_DbStatus-ZeroStatsDate-TZ,_DbStatus-ZeroStatsDate,_DbStatus-BiSize,_DbStatus-BiBlkSize,_DbStatus-BiClSize",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_DbStatus", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_DbStatus").
statusRows = sourceArray.
IF statusRows:Length = 0 THEN RETURN ERROR "openedge_db_status_missing".
statusRow = statusRows:GetJsonObject(1).
databaseIdentity:Add("productVersion", TRIM(statusRow:GetCharacter("_DbStatus-OEVersion"))).
databaseIdentity:Add("startedAt", TRIM(statusRow:GetCharacter("_DbStatus-starttime"))).
IF statusRow:Has("_DbStatus-ZeroStatsDate-TZ") AND
   TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate-TZ")) <> "" THEN
  databaseIdentity:Add("statisticsResetAt", TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate-TZ"))).
ELSE
  databaseIdentity:Add("statisticsResetAt", TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate"))).

RUN captureSource(INPUT "_ActBuffer",
  INPUT "_Buffer-LogicRds,_Buffer-LogicWrts,_Buffer-OSRds,_Buffer-OSWrts,_Buffer-Chkpts,_Buffer-Marked,_Buffer-Flushed,_Buffer-Deferred,_Buffer-LRUSkips,_Buffer-LRUwrts,_Buffer-APWEnq,_Buffer-Active,_Buffer-Free",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActBuffer", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActBuffer").

RUN captureSource(INPUT "_ActSummary",
  INPUT "_Summary-Commits,_Summary-Undos,_Summary-RecReads,_Summary-RecUpd,_Summary-RecCreat,_Summary-RecDel,_Summary-RecLock,_Summary-RecWait,_Summary-DbReads,_Summary-DbWrites,_Summary-Chkpts,_Summary-Flushed,_Summary-DbAccesses",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActSummary", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActSummary").

RUN captureSource(INPUT "_TableStat",
  INPUT "_TableStat-create,_TableStat-read,_TableStat-update,_TableStat-delete,_TableStat-OsRead",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_TableStat", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_TableStat").

RUN captureSource(INPUT "_IndexStat",
  INPUT "_IndexStat-create,_IndexStat-read,_IndexStat-delete,_IndexStat-blockdelete,_IndexStat-split,_IndexStat-OsRead",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_IndexStat", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_IndexStat").

RUN captureSource(INPUT "_Checkpoint",
  INPUT "_Checkpoint-Number,_Checkpoint-Duration,_Checkpoint-Bi-Write-Time,_Checkpoint-B-Write-Time,_Checkpoint-SyncTime,_Checkpoint-Buffers,_Checkpoint-Dirty,_Checkpoint-Flush,_Checkpoint-ApwQ,_Checkpoint-CptQ,_Checkpoint-Scan",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Checkpoint", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Checkpoint").

RUN captureSource(INPUT "_ActPWs",
  INPUT "_PW-TotDBWrites,_PW-DBWrites,_PW-ScanWrites,_PW-ApwQWrites,_PW-CkpQWrites,_PW-ScanCycles,_PW-BuffsScaned,_PW-BufsCkp,_PW-Marked,_PW-Flushed,_PW-UpTime",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActPWs", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActPWs").

RUN captureSource(INPUT "_ActBILog",
  INPUT "_BiLog-TotalWrts,_BiLog-BytesWrtn",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActBILog", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActBILog").

RUN captureSource(INPUT "_Logging",
  INPUT "_Logging-BiIO,_Logging-BiBuffs,_Logging-BiFullBuffs,_Logging-BiBytesFree",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Logging", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Logging").

RUN captureSource(INPUT "_ActIOType",
  INPUT "_IOType-IdxRds,_IOType-IdxWrts,_IOType-DataReads,_IOType-DataWrts,_IOType-BiRds,_IOType-BiWrts",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActIOType", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActIOType").

RUN captureSource(INPUT "_ActLock",
  INPUT "_Lock-ExclLock,_Lock-RecGetReq,_Lock-ShrReq,_Lock-UpgReq,_Lock-ExclReq,_Lock-RecGetLock,_Lock-ShrLock,_Lock-UpgLock,_Lock-ExclWait,_Lock-RecGetWait,_Lock-ShrWait,_Lock-UpgWait,_Lock-ExclFind,_Lock-ShrFind,_Lock-CanclReq,_Lock-Downgrade,_Lock-RedReq",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActLock", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActLock").

RUN captureSource(INPUT "_Latch",
  INPUT "_Latch-Busy,_Latch-Lock,_Latch-Wait,_Latch-Spin,_Latch-LockT,_Latch-WaitT",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Latch", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Latch").

RUN captureSource(INPUT "_DbParams",
  INPUT "_DbParams-Name,_DbParams-Value",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_DbParams", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_DbParams").

RUN captureSource(INPUT "_Trans",
  INPUT "_Trans-Duration",
  OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Trans", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Trans").

payload:Add("protocolVersion", 3).
payload:Add("database", databaseIdentity).
payload:Add("collectedAt", ISO-DATE(NOW)).
payload:Add("snapshot", snapshot).
payload:Add("unavailableSources", unavailableSources).
payload:Add("labels", labelSets).
payload:Write(INPUT-OUTPUT jsonText).
outputLength = LENGTH(jsonText).
outputOffset = 1.
DO WHILE outputOffset <= outputLength:
  outputChunk = SUBSTRING(jsonText, outputOffset, 30000).
  PUT UNFORMATTED outputChunk.
  outputOffset = outputOffset + 30000.
END.
PUT UNFORMATTED SKIP.

PROCEDURE captureSource:
  DEFINE INPUT PARAMETER sourceName AS CHARACTER NO-UNDO.
  DEFINE INPUT PARAMETER fieldNames AS CHARACTER NO-UNDO.
  DEFINE OUTPUT PARAMETER rows AS CLASS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE bufferHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE queryHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE rowNumber AS INTEGER NO-UNDO.
  DEFINE VARIABLE fieldNumber AS INTEGER NO-UNDO.
  DEFINE VARIABLE fieldName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE fieldType AS CHARACTER NO-UNDO.
  DEFINE VARIABLE labelValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE objectId AS INTEGER NO-UNDO.
  DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE indexName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE parameterName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE numericValue AS DECIMAL NO-UNDO.
  DEFINE VARIABLE stringValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE queryText AS CHARACTER NO-UNDO.

  rows = NEW JsonArray().
  sourceExists = FALSE.
  CREATE BUFFER bufferHandle FOR TABLE sourceName NO-ERROR.
  IF ERROR-STATUS:ERROR OR NOT VALID-HANDLE(bufferHandle) THEN RETURN.
  sourceExists = TRUE.
  CREATE QUERY queryHandle.
  queryHandle:SET-BUFFERS(bufferHandle).
  queryText = "FOR EACH " + sourceName + " NO-LOCK".
  IF sourceName = "_ActBuffer" THEN queryText = queryText + " BY _Buffer-Id".
  IF sourceName = "_Checkpoint" THEN queryText = queryText + " BY _Checkpoint-Number".
  queryHandle:QUERY-PREPARE(queryText).
  queryHandle:QUERY-OPEN().
  queryHandle:GET-FIRST().
  rowNumber = 0.
  DO WHILE NOT queryHandle:QUERY-OFF-END:
    rowNumber = rowNumber + 1.
    labelValue = "".
    IF sourceName = "_ActBuffer" THEN DO:
      /* Row 1 is the combined total. Rows 2 and 3 are primary and alternate. */
      IF rowNumber = 1 THEN DO:
        queryHandle:GET-NEXT().
        NEXT.
      END.
      IF rowNumber = 2 THEN labelValue = "primary".
      ELSE IF rowNumber = 3 THEN labelValue = "alternate".
      ELSE DO:
        queryHandle:GET-NEXT().
        NEXT.
      END.
    END.
    IF sourceName = "_DbParams" THEN DO:
      fieldHandle = bufferHandle:BUFFER-FIELD("_DbParams-Name") NO-ERROR.
      IF NOT VALID-HANDLE(fieldHandle) THEN DO:
        queryHandle:GET-NEXT().
        NEXT.
      END.
      parameterName = TRIM(STRING(fieldHandle:BUFFER-VALUE)).
      IF NOT CAN-DO("-B,-B2,-bithold,-basetable,-tablerangesize,-baseindex,-indexrangesize", parameterName) THEN DO:
        queryHandle:GET-NEXT().
        NEXT.
      END.
    END.

    rowObject = NEW JsonObject().
    DO fieldNumber = 1 TO NUM-ENTRIES(fieldNames):
      fieldName = ENTRY(fieldNumber, fieldNames).
      fieldHandle = bufferHandle:BUFFER-FIELD(fieldName) NO-ERROR.
      IF NOT VALID-HANDLE(fieldHandle) THEN NEXT.
      fieldType = CAPS(fieldHandle:DATA-TYPE).
      IF fieldType = "INTEGER" OR fieldType = "INT64" OR fieldType = "DECIMAL" THEN DO:
        numericValue = DECIMAL(fieldHandle:BUFFER-VALUE) NO-ERROR.
        IF NOT ERROR-STATUS:ERROR AND numericValue <> ? THEN
          rowObject:Add(fieldName, numericValue).
      END.
      ELSE DO:
        stringValue = TRIM(STRING(fieldHandle:BUFFER-VALUE)).
        IF stringValue <> ? THEN rowObject:Add(fieldName, stringValue).
      END.
    END.

    IF sourceName = "_ActBuffer" THEN rowObject:Add("pool", labelValue).
    IF sourceName = "_DbParams" THEN rowObject:Add("parameter", parameterName).
    IF sourceName = "_TableStat" THEN DO:
      fieldHandle = bufferHandle:BUFFER-FIELD("_TableStat-id") NO-ERROR.
      IF VALID-HANDLE(fieldHandle) THEN DO:
        objectId = INTEGER(fieldHandle:BUFFER-VALUE).
        FIND FIRST _File NO-LOCK WHERE _File._File-Number = objectId NO-ERROR.
        tableName = IF AVAILABLE _File AND _File._Tbl-Type = "T"
                    THEN _File._File-Name ELSE "".
        /* _TableStat exposes every configured range slot, including unused IDs.
           Exclude those slots instead of inventing an "other" table. */
        IF tableName = "" THEN DO:
          queryHandle:GET-NEXT().
          NEXT.
        END.
        rowObject:Add("table", tableName).
      END.
    END.
    IF sourceName = "_IndexStat" THEN DO:
      fieldHandle = bufferHandle:BUFFER-FIELD("_IndexStat-id") NO-ERROR.
      IF VALID-HANDLE(fieldHandle) THEN DO:
        objectId = INTEGER(fieldHandle:BUFFER-VALUE).
        FIND FIRST _Index NO-LOCK WHERE _Index._idx-num = objectId NO-ERROR.
        IF AVAILABLE _Index THEN DO:
          FIND FIRST _File NO-LOCK WHERE RECID(_File) = _Index._File-recid NO-ERROR.
          tableName = IF AVAILABLE _File THEN _File._File-Name ELSE "".
          indexName = IF tableName <> "" THEN tableName + "." + _Index._Index-Name ELSE "".
          IF LOOKUP(indexName, indexLabels) = 0 THEN indexName = "other".
        END.
        ELSE indexName = "other".
        rowObject:Add("index", indexName).
      END.
    END.
    rows:Add(rowObject).
    queryHandle:GET-NEXT().
  END.
  queryHandle:QUERY-CLOSE().
  DELETE OBJECT queryHandle.
  DELETE OBJECT bufferHandle.
END PROCEDURE.

PROCEDURE captureParameterSnapshot:
  DEFINE VARIABLE resultObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE resultRows AS JsonArray NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE databaseBuffer AS HANDLE NO-UNDO.
  DEFINE VARIABLE databaseQuery AS HANDLE NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE rowName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE rowValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE rowDtype AS INTEGER NO-UNDO.
  DEFINE VARIABLE defaultValue AS LOGICAL NO-UNDO.
  DEFINE VARIABLE modifiableValue AS LOGICAL NO-UNDO.
  DEFINE VARIABLE captureStatus AS CHARACTER NO-UNDO INITIAL "complete".
  DEFINE VARIABLE captureReason AS CHARACTER NO-UNDO.
  DEFINE VARIABLE estimatedBytes AS INTEGER NO-UNDO INITIAL 512.
  DEFINE VARIABLE attemptTime AS CHARACTER NO-UNDO.
  DEFINE VARIABLE outputText AS LONGCHAR NO-UNDO.
  DEFINE VARIABLE outputOffset AS INTEGER NO-UNDO.
  DEFINE VARIABLE outputPiece AS CHARACTER NO-UNDO.

  attemptTime = ISO-DATE(NOW).
  resultObject = NEW JsonObject().
  resultRows = NEW JsonArray().
  CREATE BUFFER databaseBuffer FOR TABLE "_DbParams" NO-ERROR.
  IF ERROR-STATUS:ERROR OR NOT VALID-HANDLE(databaseBuffer) THEN DO:
    captureStatus = "unavailable".
    captureReason = "dbparams_source_unavailable".
  END.
  ELSE DO:
    CREATE QUERY databaseQuery.
    databaseQuery:SET-BUFFERS(databaseBuffer).
    databaseQuery:QUERY-PREPARE("FOR EACH _DbParams NO-LOCK") NO-ERROR.
    IF ERROR-STATUS:ERROR THEN DO:
      captureStatus = "unavailable".
      captureReason = "dbparams_query_unavailable".
    END.
    ELSE DO:
      databaseQuery:QUERY-OPEN() NO-ERROR.
      IF ERROR-STATUS:ERROR THEN DO:
        captureStatus = "unavailable".
        captureReason = "dbparams_query_unavailable".
      END.
      ELSE DO:
        databaseQuery:GET-FIRST().
        DO WHILE NOT databaseQuery:QUERY-OFF-END:
          IF resultRows:Length >= 1024 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_row_limit_exceeded".
            LEAVE.
          END.
          fieldHandle = databaseBuffer:BUFFER-FIELD("_DbParams-Name") NO-ERROR.
          IF NOT VALID-HANDLE(fieldHandle) THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_name_unavailable".
            LEAVE.
          END.
          rowName = TRIM(STRING(fieldHandle:BUFFER-VALUE)).
          IF rowName = ? OR rowName = "" THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_name_unavailable".
            LEAVE.
          END.
          IF LENGTH(rowName, "RAW":U) > 128 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_name_limit_exceeded".
            LEAVE.
          END.
          rowObject = NEW JsonObject().
          rowObject:Add("name", rowName).
          fieldHandle = databaseBuffer:BUFFER-FIELD("_DbParams-Value") NO-ERROR.
          rowValue = ?.
          IF VALID-HANDLE(fieldHandle) THEN rowValue = STRING(fieldHandle:BUFFER-VALUE).
          IF rowValue <> ? AND LENGTH(rowValue, "RAW":U) > 65536 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_capture_value_limit_exceeded:" + rowName.
            LEAVE.
          END.
          estimatedBytes = estimatedBytes + LENGTH(rowName, "RAW":U) +
            (IF rowValue = ? THEN 4 ELSE LENGTH(rowValue, "RAW":U)) + 256.
          IF estimatedBytes > 2000000 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_response_limit_exceeded:" + rowName.
            LEAVE.
          END.
          IF rowValue <> ? AND LENGTH(rowValue, "RAW":U) > 8192 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_metric_value_limit_exceeded:" + rowName.
          END.
          rowObject:Add("rawValue", rowValue).
          fieldHandle = databaseBuffer:BUFFER-FIELD("_DbParams-dtype") NO-ERROR.
          rowDtype = ?.
          IF VALID-HANDLE(fieldHandle) THEN rowDtype = INTEGER(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("dtype", rowDtype).
          fieldHandle = databaseBuffer:BUFFER-FIELD("_DbParams-Is-Default") NO-ERROR.
          defaultValue = ?.
          IF VALID-HANDLE(fieldHandle) THEN defaultValue = LOGICAL(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("isDefault", defaultValue).
          IF defaultValue = ? THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_default_flag_unavailable:" + rowName.
          END.
          fieldHandle = databaseBuffer:BUFFER-FIELD("_DbParams-Is-Modifiable") NO-ERROR.
          modifiableValue = ?.
          IF VALID-HANDLE(fieldHandle) THEN modifiableValue = LOGICAL(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("isModifiable", modifiableValue).
          resultRows:Add(rowObject).
          databaseQuery:GET-NEXT().
        END.
        databaseQuery:QUERY-CLOSE().
      END.
    END.
    DELETE OBJECT databaseQuery.
    DELETE OBJECT databaseBuffer.
  END.
  resultObject:Add("contractVersion", "openedge-db-parameter-capture.v1").
  resultObject:Add("databaseName", PDBNAME("DICTDB")).
  resultObject:Add("attemptedAt", attemptTime).
  resultObject:Add("source", "_DbParams").
  resultObject:Add("status", captureStatus).
  IF captureStatus <> "unavailable" AND (captureStatus = "complete" OR resultRows:Length > 0) THEN
    resultObject:Add("capturedAt", ISO-DATE(NOW)).
  IF captureStatus <> "complete" THEN resultObject:Add("reason", captureReason).
  resultObject:Add("rows", resultRows).
  resultObject:Write(INPUT-OUTPUT outputText).
  outputOffset = 1.
  DO WHILE outputOffset <= LENGTH(outputText):
    outputPiece = SUBSTRING(outputText, outputOffset, 30000).
    PUT UNFORMATTED outputPiece.
    outputOffset = outputOffset + 30000.
  END.
  PUT UNFORMATTED SKIP.
END PROCEDURE.

/*
  Reads the metric label sets from the database's own metaschema: application tables by name
  (all names) and their indexes as "Table.Index" (at most 256). They are reported with every
  snapshot so the adapter validates against the same sets.
*/
PROCEDURE loadLabelSets:
  DEFINE VARIABLE tableArray AS JsonArray NO-UNDO.
  DEFINE VARIABLE indexArray AS JsonArray NO-UNDO.

  ASSIGN
    tableArray = NEW JsonArray()
    indexArray = NEW JsonArray()
    labelSets = NEW JsonObject().
  FOR EACH _File NO-LOCK WHERE _File._Tbl-Type = "T" BY _File._File-Name:
    tableArray:Add(_File._File-Name).
    FOR EACH _Index NO-LOCK WHERE _Index._File-recid = RECID(_File) BY _Index._Index-Name:
      IF indexArray:Length >= 256 THEN LEAVE.
      indexArray:Add(_File._File-Name + "." + _Index._Index-Name).
      indexLabels = indexLabels + (IF indexLabels = "" THEN "" ELSE ",") + _File._File-Name + "." + _Index._Index-Name.
    END.
  END.
  labelSets:Add("tables", tableArray).
  labelSets:Add("indexes", indexArray).
END PROCEDURE.
