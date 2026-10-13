USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonObject.

/* Connected-schema preparation can explicitly disable an absent source.
   Defaults describe the nominal full-source schema, not a patch guarantee. */
&IF DEFINED(PB_HAS_DBSTATUS) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_DBSTATUS 1
&ENDIF
&IF {&PB_HAS_DBSTATUS} = 1 &THEN
DEFINE BUFFER bDbStatus FOR _DbStatus.
&ENDIF

&IF DEFINED(PB_HAS_ACTBUFFER) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTBUFFER 1
&ENDIF
&IF {&PB_HAS_ACTBUFFER} = 1 &THEN
DEFINE BUFFER bActBuffer FOR _ActBuffer.
&ENDIF

&IF DEFINED(PB_HAS_BUFFSTATUS) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_BUFFSTATUS 1
&ENDIF
&IF {&PB_HAS_BUFFSTATUS} = 1 &THEN
DEFINE BUFFER bBuffStatus FOR _BuffStatus.
&ENDIF

&IF DEFINED(PB_HAS_ACTSUMMARY) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTSUMMARY 1
&ENDIF
&IF {&PB_HAS_ACTSUMMARY} = 1 &THEN
DEFINE BUFFER bActSummary FOR _ActSummary.
&ENDIF

&IF DEFINED(PB_HAS_TABLESTAT) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_TABLESTAT 1
&ENDIF
&IF {&PB_HAS_TABLESTAT} = 1 &THEN
DEFINE BUFFER bTableStat FOR _TableStat.
&ENDIF

&IF DEFINED(PB_HAS_INDEXSTAT) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_INDEXSTAT 1
&ENDIF
&IF {&PB_HAS_INDEXSTAT} = 1 &THEN
DEFINE BUFFER bIndexStat FOR _IndexStat.
&ENDIF

&IF DEFINED(PB_HAS_CHECKPOINT) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_CHECKPOINT 1
&ENDIF
&IF {&PB_HAS_CHECKPOINT} = 1 &THEN
DEFINE BUFFER bCheckpoint FOR _Checkpoint.
&ENDIF

&IF DEFINED(PB_HAS_ACTPWS) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTPWS 1
&ENDIF
&IF {&PB_HAS_ACTPWS} = 1 &THEN
DEFINE BUFFER bActPWs FOR _ActPWs.
&ENDIF

&IF DEFINED(PB_HAS_ACTBILOG) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTBILOG 1
&ENDIF
&IF {&PB_HAS_ACTBILOG} = 1 &THEN
DEFINE BUFFER bActBILog FOR _ActBILog.
&ENDIF

&IF DEFINED(PB_HAS_LOGGING) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_LOGGING 1
&ENDIF
&IF {&PB_HAS_LOGGING} = 1 &THEN
DEFINE BUFFER bLogging FOR _Logging.
&ENDIF

&IF DEFINED(PB_HAS_ACTIOTYPE) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTIOTYPE 1
&ENDIF
&IF {&PB_HAS_ACTIOTYPE} = 1 &THEN
DEFINE BUFFER bActIOType FOR _ActIOType.
&ENDIF

&IF DEFINED(PB_HAS_ACTLOCK) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_ACTLOCK 1
&ENDIF
&IF {&PB_HAS_ACTLOCK} = 1 &THEN
DEFINE BUFFER bActLock FOR _ActLock.
&ENDIF

&IF DEFINED(PB_HAS_LATCH) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_LATCH 1
&ENDIF
&IF {&PB_HAS_LATCH} = 1 &THEN
DEFINE BUFFER bLatch FOR _Latch.
&ENDIF

&IF DEFINED(PB_HAS_DBPARAMS) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_DBPARAMS 1
&ENDIF
&IF {&PB_HAS_DBPARAMS} = 1 &THEN
DEFINE BUFFER bDbParams FOR _DbParams.
&ENDIF

&IF DEFINED(PB_HAS_TRANS) = 0 &THEN
&GLOBAL-DEFINE PB_HAS_TRANS 1
&ENDIF
&IF {&PB_HAS_TRANS} = 1 &THEN
DEFINE BUFFER bTrans FOR _Trans.
&ENDIF

DEFINE VARIABLE payload AS JsonObject NO-UNDO.
DEFINE VARIABLE latchInventory AS JsonObject NO-UNDO.
DEFINE VARIABLE databaseIdentity AS JsonObject NO-UNDO.
DEFINE VARIABLE snapshot AS JsonObject NO-UNDO.
DEFINE VARIABLE sourceArray AS JsonArray NO-UNDO.
DEFINE VARIABLE unavailableSources AS JsonArray NO-UNDO.
DEFINE VARIABLE statusRows AS JsonArray NO-UNDO.
DEFINE VARIABLE statusRow AS JsonObject NO-UNDO.
DEFINE VARIABLE sourcePresent AS LOGICAL NO-UNDO.

DEFINE VARIABLE indexLabels AS CHARACTER NO-UNDO.
DEFINE VARIABLE labelSets AS JsonObject NO-UNDO.

/* Feature 017: all state belongs to this invocation. Metadata changes are
   observed by the next invocation, after a fresh complete startup copy. */
DEFINE TEMP-TABLE ttFile NO-UNDO
  /* Preserve the original database identity for index ownership. */
  FIELD sourceRecid AS RECID
  /* _File-Number identifies the statistics range slot; not globally unique. */
  FIELD tableNumber AS INTEGER
  /* _File-Name is the raw label; _Tbl-Type identifies application tables. */
  FIELD tableName AS CHARACTER
  FIELD tableType AS CHARACTER
  INDEX originalIdentity IS UNIQUE sourceRecid
  INDEX tableNumber tableNumber
  INDEX applicationName tableType tableName.

DEFINE TEMP-TABLE ttIndex NO-UNDO
  /* _idx-num maps index statistics to an index; no new uniqueness assumption. */
  FIELD indexNumber AS INTEGER
  /* _Index-Name supplies the raw index label. */
  FIELD indexName AS CHARACTER
  /* _File-recid is the original owner identity, never a copied record RECID. */
  FIELD sourceFileRecid AS RECID
  INDEX indexNumber indexNumber
  INDEX ownerName sourceFileRecid indexName.

/* Population precedes both modes. No later label/metric lookup reads the DB
   metaschema. Schema is assumed stable while these two inventories are copied. */
RUN initializeMetadata NO-ERROR.
IF ERROR-STATUS:ERROR THEN RETURN ERROR "openedge_db_metadata_initialization_failed".
IF SESSION:PARAMETER = "parameter-capture" THEN DO:
  RUN captureParameterSnapshot.
  RETURN.
END.
RUN loadLabelSets.
payload = NEW JsonObject().
databaseIdentity = NEW JsonObject().
snapshot = NEW JsonObject().
unavailableSources = NEW JsonArray().

RUN captureDbStatus(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_DbStatus", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_DbStatus").
statusRows = sourceArray.
IF statusRows:Length = 0 THEN RETURN ERROR "openedge_db_status_missing".
statusRow = statusRows:GetJsonObject(1).
databaseIdentity:Add("name", PDBNAME("DICTDB")).
databaseIdentity:Add("productVersion", TRIM(statusRow:GetCharacter("_DbStatus-OEVersion"))).
databaseIdentity:Add("startedAt", TRIM(statusRow:GetCharacter("_DbStatus-starttime"))).
IF statusRow:Has("_DbStatus-ZeroStatsDate-TZ") AND
   TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate-TZ")) <> "" THEN
  databaseIdentity:Add("statisticsResetAt", TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate-TZ"))).
ELSE
  databaseIdentity:Add("statisticsResetAt", TRIM(statusRow:GetCharacter("_DbStatus-ZeroStatsDate"))).

RUN captureActBuffer(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActBuffer", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActBuffer").

RUN captureActSummary(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActSummary", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActSummary").

RUN captureTableStat(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_TableStat", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_TableStat").

RUN captureIndexStat(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_IndexStat", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_IndexStat").

RUN captureCheckpoint(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Checkpoint", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Checkpoint").

RUN captureActPWs(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActPWs", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActPWs").

RUN captureActBILog(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActBILog", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActBILog").

RUN captureLogging(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Logging", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Logging").

RUN captureActIOType(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActIOType", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActIOType").

RUN captureActLock(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_ActLock", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_ActLock").

RUN captureLatch(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Latch", sourceArray).
IF NOT sourcePresent OR sourceArray:Length = 0 THEN RETURN ERROR "openedge_db_named_latch_inventory_missing".
latchInventory = NEW JsonObject().
latchInventory:Add("complete", TRUE).
latchInventory:Add("count", sourceArray:Length).
latchInventory:Add("runId", OS-GETENV("PARKBENCH_RUN_ID")).
latchInventory:Add("authoritativePublisher", "endpoint").
IF NOT sourcePresent THEN unavailableSources:Add("_Latch").

RUN captureBuffStatus(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_BuffStatus", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_BuffStatus").

RUN captureDbParams(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_DbParams", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_DbParams").

RUN captureTrans(OUTPUT sourceArray, OUTPUT sourcePresent).
snapshot:Add("_Trans", sourceArray).
IF NOT sourcePresent THEN unavailableSources:Add("_Trans").

payload:Add("protocolVersion", 4).
payload:Add("latchInventory", latchInventory).
payload:Add("database", databaseIdentity).
payload:Add("collectedAt", ISO-DATE(NOW)).
payload:Add("snapshot", snapshot).
payload:Add("unavailableSources", unavailableSources).
payload:Add("labels", labelSets).
RUN emitJson(INPUT payload).

PROCEDURE initializeMetadata:
  EMPTY TEMP-TABLE ttFile.
  EMPTY TEMP-TABLE ttIndex.
  DO ON ERROR UNDO, RETURN ERROR "openedge_db_metadata_initialization_failed":
    FOR EACH _File NO-LOCK:
      CREATE ttFile.
      /* Include every accessible row, assigning only naming/ownership fields. */
      ASSIGN ttFile.sourceRecid = RECID(_File)
             ttFile.tableNumber = _File._File-Number
             ttFile.tableName = _File._File-Name
             ttFile.tableType = _File._Tbl-Type.
      RELEASE ttFile.
    END.
    FOR EACH _Index NO-LOCK:
      CREATE ttIndex.
      ASSIGN ttIndex.indexNumber = _Index._idx-num
             ttIndex.indexName = _Index._Index-Name
             ttIndex.sourceFileRecid = _Index._File-recid.
      RELEASE ttIndex.
    END.
  END.
END PROCEDURE.

/* Unlimited application table names; only emitted index names have a cap.
   All index metadata remains available for statistics lookup. */
PROCEDURE loadLabelSets:
  DEFINE VARIABLE tableArray AS JsonArray NO-UNDO.
  DEFINE VARIABLE indexArray AS JsonArray NO-UNDO.
  ASSIGN tableArray = NEW JsonArray()
         indexArray = NEW JsonArray()
         labelSets = NEW JsonObject()
         indexLabels = "".
  /* _Tbl-Type identifies application tables; _File-Name is their raw name. */
  FOR EACH ttFile WHERE ttFile.tableType = "T" BY ttFile.tableName:
    tableArray:Add(ttFile.tableName).
    /* _File-recid references the original database RECID; _Index-Name is
       the raw index name. Copied RECIDs are never used as owner identities. */
    FOR EACH ttIndex WHERE ttIndex.sourceFileRecid = ttFile.sourceRecid
        BY ttIndex.indexName:
      IF indexArray:Length >= 256 THEN LEAVE.
      indexArray:Add(ttFile.tableName + "." + ttIndex.indexName).
      indexLabels = indexLabels + (IF indexLabels = "" THEN "" ELSE ",")
        + ttFile.tableName + "." + ttIndex.indexName.
    END.
  END.
  labelSets:Add("tables", tableArray).
  labelSets:Add("indexes", indexArray).
END PROCEDURE.

/* Preserve the original one-field numeric/STRING/TRIM/unknown sequence.
   The caller explicitly names each field; this helper owns no traversal,
   filtering, field list or source-name dispatch. */
PROCEDURE addField:
  DEFINE INPUT PARAMETER rowObject AS JsonObject NO-UNDO.
  DEFINE INPUT PARAMETER sourceBuffer AS HANDLE NO-UNDO.
  DEFINE INPUT PARAMETER fieldName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE fieldType AS CHARACTER NO-UNDO.
  DEFINE VARIABLE numericValue AS DECIMAL NO-UNDO.
  DEFINE VARIABLE stringValue AS CHARACTER NO-UNDO.
  fieldHandle = sourceBuffer:BUFFER-FIELD(fieldName) NO-ERROR.
  IF NOT VALID-HANDLE(fieldHandle) THEN RETURN.
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
END PROCEDURE.

/* Native identity text is preserved; trimming would change an exact selector. */
PROCEDURE addExactLatchText:
  DEFINE INPUT PARAMETER rowObject AS JsonObject NO-UNDO.
  DEFINE INPUT PARAMETER sourceBuffer AS HANDLE NO-UNDO.
  DEFINE INPUT PARAMETER fieldName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE nativeValue AS CHARACTER NO-UNDO.
  fieldHandle = sourceBuffer:BUFFER-FIELD(fieldName) NO-ERROR.
  IF NOT VALID-HANDLE(fieldHandle) THEN RETURN ERROR "openedge_db_named_latch_identity_missing".
  nativeValue = STRING(fieldHandle:BUFFER-VALUE).
  IF nativeValue = ? OR TRIM(nativeValue) = "" OR LENGTH(nativeValue) > 256 THEN RETURN ERROR "openedge_db_named_latch_identity_invalid".
  rowObject:Add(fieldName, nativeValue).
END PROCEDURE.

PROCEDURE emitJson:
  DEFINE INPUT PARAMETER objectToEmit AS JsonObject NO-UNDO.
  DEFINE VARIABLE textToEmit AS LONGCHAR NO-UNDO.
  DEFINE VARIABLE offsetToEmit AS INTEGER NO-UNDO.
  DEFINE VARIABLE chunkToEmit AS CHARACTER NO-UNDO.
  objectToEmit:Write(INPUT-OUTPUT textToEmit).
  offsetToEmit = 1.
  DO WHILE offsetToEmit <= LENGTH(textToEmit):
    chunkToEmit = SUBSTRING(textToEmit, offsetToEmit, 30000).
    PUT UNFORMATTED chunkToEmit.
    offsetToEmit = offsetToEmit + 30000.
  END.
  PUT UNFORMATTED SKIP.
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management/page/Database-status-_DbStatus.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureDbStatus:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_DBSTATUS} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bDbStatus NO-LOCK:
    rowObject = NEW JsonObject().
    /* Product version string used to identify the connected database runtime. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-OEVersion").
    /* Database startup time string; retained as the database epoch identity. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-starttime").
    /* Timezone-aware statistics reset timestamp; preferred when present and nonempty. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-ZeroStatsDate-TZ").
    /* Older statistics reset timestamp; fallback when the timezone field is unavailable. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-ZeroStatsDate").
    /* BI logical size; baseline interprets blocks per Progress monitoring example, not universally verified units. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-BiSize").
    /* Current BI block size in bytes; adapter uses it for the retained size conversion. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-BiBlkSize").
    /* Current BI cluster size in kilobytes; adapter retains its byte conversion. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbStatus:HANDLE, INPUT "_DbStatus-BiClSize").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Buffer-activity-_ActBuffer.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActBuffer:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE rowNumber AS INTEGER NO-UNDO.
  DEFINE VARIABLE labelValue AS CHARACTER NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTBUFFER} = 1 &THEN
  sourceExists = TRUE.
  /* _Buffer-Id sorts pools. Preserve positional rows: combined, primary, alternate. */
  FOR EACH bActBuffer NO-LOCK BY bActBuffer._Buffer-Id:
    rowNumber = rowNumber + 1.
    IF rowNumber = 1 OR rowNumber > 3 THEN NEXT.
    labelValue = IF rowNumber = 2 THEN "primary" ELSE "alternate".
    rowObject = NEW JsonObject().
    /* Cumulative logical block read requests by clients in this buffer pool. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-LogicRds").
    /* Cumulative logical block write requests by clients in this buffer pool. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-LogicWrts").
    /* Cumulative disk block reads for this pool. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-OSRds").
    /* Cumulative disk block writes for this pool. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-OSWrts").
    /* Cumulative checkpoints for this pool. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Chkpts").
    /* Cumulative modified blocks scheduled for writing before checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Marked").
    /* Cumulative blocks forced to disk at checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Flushed").
    /* Cumulative block changes before a write, representing potentially avoided I/O. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Deferred").
    /* Cumulative locked or modified buffers skipped during LRU replacement. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-LRUSkips").
    /* Cumulative blocks written to reuse their buffers for reads. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-LRUwrts").
    /* Cumulative modified buffers queued for asynchronous page writers. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-APWEnq").
    /* Current active buffer count in this pool; a gauge. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Active").
    /* Current free buffer count in this pool; a gauge. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBuffer:HANDLE, INPUT "_Buffer-Free").
    rowObject:Add("pool", labelValue).
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Summary-activity-_ActSummary.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActSummary:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTSUMMARY} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bActSummary NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative committed user transactions, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-Commits").
    /* Cumulative transaction rollbacks, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-Undos").
    /* Cumulative record read accesses, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecReads").
    /* Cumulative record update accesses, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecUpd").
    /* Cumulative record creation accesses, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecCreat").
    /* Cumulative record deletion accesses, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecDel").
    /* Cumulative record locks used, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecLock").
    /* Cumulative waits for locked records, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-RecWait").
    /* Cumulative database block reads, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-DbReads").
    /* Cumulative database disk block writes, across the database. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-DbWrites").
    /* Cumulative count of database checkpoints. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-Chkpts").
    /* Cumulative buffers forced out at checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-Flushed").
    /* Cumulative shared/exclusive database buffer lock waits; legacy database-access metric mapping is retained. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActSummary:HANDLE, INPUT "_Summary-DbAccesses").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management/page/Table-statistics-_TableStat.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureTableStat:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE objectId AS INTEGER NO-UNDO.
  DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_TABLESTAT} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bTableStat NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative record creation accesses for this table. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTableStat:HANDLE, INPUT "_TableStat-create").
    /* Cumulative record read accesses for this table. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTableStat:HANDLE, INPUT "_TableStat-read").
    /* Cumulative record update accesses for this table. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTableStat:HANDLE, INPUT "_TableStat-update").
    /* Cumulative record deletion accesses for this table. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTableStat:HANDLE, INPUT "_TableStat-delete").
    /* Table disk reads since startup; documented for Type II areas, with baseline emission retained. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTableStat:HANDLE, INPUT "_TableStat-OsRead").
    /* Statistics table number maps a configured slot to the cached metadata.
       Missing field retains the original unlabeled row; unused/internal slots skip. */
    fieldHandle = BUFFER bTableStat:BUFFER-FIELD("_TableStat-id") NO-ERROR.
    IF VALID-HANDLE(fieldHandle) THEN DO:
      objectId = INTEGER(fieldHandle:BUFFER-VALUE).
      FIND FIRST ttFile WHERE ttFile.tableNumber = objectId NO-ERROR.
      tableName = IF AVAILABLE ttFile AND ttFile.tableType = "T" THEN ttFile.tableName ELSE "".
      IF tableName = "" THEN NEXT.
      rowObject:Add("table", tableName).
    END.
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Index-statistics-_IndexStat.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureIndexStat:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE objectId AS INTEGER NO-UNDO.
  DEFINE VARIABLE tableName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE indexName AS CHARACTER NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_INDEXSTAT} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bIndexStat NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative index entry creation accesses for this index. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-create").
    /* Cumulative index read accesses for this index. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-read").
    /* Cumulative index entry deletion accesses for this index. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-delete").
    /* Cumulative index block deletions for this index. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-blockdelete").
    /* Cumulative index block splits for this index. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-split").
    /* Index disk reads since database startup. */
    RUN addField(INPUT rowObject, INPUT BUFFER bIndexStat:HANDLE, INPUT "_IndexStat-OsRead").
    /* Statistics index number resolves original owner identity in the caches.
       Unmapped owners and names outside the selected 256 labels retain "other". */
    fieldHandle = BUFFER bIndexStat:BUFFER-FIELD("_IndexStat-id") NO-ERROR.
    IF VALID-HANDLE(fieldHandle) THEN DO:
      objectId = INTEGER(fieldHandle:BUFFER-VALUE).
      FIND FIRST ttIndex WHERE ttIndex.indexNumber = objectId NO-ERROR.
      IF AVAILABLE ttIndex THEN DO:
        FIND FIRST ttFile WHERE ttFile.sourceRecid = ttIndex.sourceFileRecid NO-ERROR.
        tableName = IF AVAILABLE ttFile THEN ttFile.tableName ELSE "".
        indexName = IF tableName <> "" THEN tableName + "." + ttIndex.indexName ELSE "".
        IF LOOKUP(indexName, indexLabels) = 0 THEN indexName = "other".
      END.
      ELSE indexName = "other".
      rowObject:Add("index", indexName).
    END.
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Checkpoint-_Checkpoint.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureCheckpoint:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_CHECKPOINT} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bCheckpoint NO-LOCK BY bCheckpoint._Checkpoint-Number:
    rowObject = NEW JsonObject().
    /* Checkpoint sequence number; orders retained checkpoint history, not an activity counter. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Number").
    /* Checkpoint housekeeping duration, not full interval; raw unit unspecified here, adapter retains seconds interpretation. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Duration").
    /* Seconds writing BI buffers at the end of this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Bi-Write-Time").
    /* Seconds writing database buffers at the end of this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-B-Write-Time").
    /* Filesystem synchronization duration; reference lacks explicit raw unit, adapter retains seconds interpretation. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-SyncTime").
    /* Number of buffers checkpointed for this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Buffers").
    /* Number of modified buffers scheduled for writing during this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Dirty").
    /* Number of buffers forced out at checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Flush").
    /* Buffers written from APW queue or replaced from LRU during this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-ApwQ").
    /* Buffers written by APWs from the checkpoint queue for this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-CptQ").
    /* Buffers written during APW scan cycles for this checkpoint. */
    RUN addField(INPUT rowObject, INPUT BUFFER bCheckpoint:HANDLE, INPUT "_Checkpoint-Scan").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Page-writer-activity-_ActPWs.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActPWs:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTPWS} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bActPWs NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative database buffer writes by all processes, including non-APW writers. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-TotDBWrites").
    /* Cumulative database buffer writes by asynchronous page writers only. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-DBWrites").
    /* Cumulative buffers written during asynchronous page writer scans. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-ScanWrites").
    /* Cumulative buffers written while clearing the APW queue. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-ApwQWrites").
    /* Cumulative buffers written from the checkpoint queue. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-CkpQWrites").
    /* Cumulative asynchronous page writer scan cycles. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-ScanCycles").
    /* Cumulative buffers examined during asynchronous page writer scans. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-BuffsScaned").
    /* Cumulative buffers checkpointed by asynchronous page writers. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-BufsCkp").
    /* Cumulative modified buffers scheduled before checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-Marked").
    /* Cumulative buffers forced out at checkpoint end. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-Flushed").
    /* Database uptime in seconds, not individual writer lifetime; adapter retains maximum across rows. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActPWs:HANDLE, INPUT "_PW-UpTime").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Before-image-log-activity-_ActBILog.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActBILog:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTBILOG} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bActBILog NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative BI file write operations; legacy blocks-written mapping remains, not necessarily full physical blocks. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBILog:HANDLE, INPUT "_BiLog-TotalWrts").
    /* Cumulative bytes written to the BI file. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActBILog:HANDLE, INPUT "_BiLog-BytesWrtn").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Logging-_Logging.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureLogging:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_LOGGING} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bLogging NO-LOCK:
    rowObject = NEW JsonObject().
    /* Current BI I/O mode string, Reliable or BUFFERED; adapter retains its 0/1 conversion. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLogging:HANDLE, INPUT "_Logging-BiIO").
    /* Current allocated BI buffer count; a gauge. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLogging:HANDLE, INPUT "_Logging-BiBuffs").
    /* Current full BI buffer count; a gauge. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLogging:HANDLE, INPUT "_Logging-BiFullBuffs").
    /* Current free bytes in the BI cluster; a gauge. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLogging:HANDLE, INPUT "_Logging-BiBytesFree").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Inputoutput-type-activity-_ActIOType.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActIOType:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTIOTYPE} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bActIOType NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative index block read operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-IdxRds").
    /* Cumulative index block write operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-IdxWrts").
    /* Cumulative data block read operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-DataReads").
    /* Cumulative data block write operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-DataWrts").
    /* Cumulative BI block read operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-BiRds").
    /* Cumulative BI block write operations. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActIOType:HANDLE, INPUT "_IOType-BiWrts").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-122/page/Lock-table-activity-_ActLock.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureActLock:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_ACTLOCK} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bActLock NO-LOCK:
    rowObject = NEW JsonObject().
    /* Cumulative exclusive lock requests; despite the suffix, this is requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ExclLock").
    /* Cumulative record-get lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-RecGetReq").
    /* Cumulative shared lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ShrReq").
    /* Cumulative shared-to-exclusive lock upgrade requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-UpgReq").
    /* Cumulative exclusive requests granted; despite the suffix, this is grants. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ExclReq").
    /* Cumulative record-get lock requests granted. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-RecGetLock").
    /* Cumulative shared lock requests granted. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ShrLock").
    /* Cumulative lock upgrade requests granted. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-UpgLock").
    /* Cumulative waits on exclusive lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ExclWait").
    /* Cumulative waits on record-get lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-RecGetWait").
    /* Cumulative waits on shared lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ShrWait").
    /* Cumulative waits on upgrade requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-UpgWait").
    /* Cumulative exclusive find locks released; legacy grants metric terminology remains unchanged. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ExclFind").
    /* Cumulative shared find lock requests granted. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-ShrFind").
    /* Cumulative cancelled lock requests. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-CanclReq").
    /* Cumulative count of lock downgrades. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-Downgrade").
    /* Cumulative duplicate lock requests granted. */
    RUN addField(INPUT rowObject, INPUT BUFFER bActLock:HANDLE, INPUT "_Lock-RedReq").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Latch-statistics-_Latch.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureLatch:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_LATCH} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bLatch NO-LOCK:
    rowObject = NEW JsonObject().
    IF rows:Length >= 512 THEN RETURN ERROR "openedge_db_named_latch_inventory_limit".
    RUN addExactLatchText(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Name").
    RUN addExactLatchText(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Type").
    rowObject:Add("latch_id", STRING(ROWID(bLatch))).
    /* Cumulative occasions this latch was busy. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Busy").
    /* Cumulative acquisitions of this latch. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Lock").
    /* Cumulative naps while waiting for this latch. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Wait").
    /* Cumulative spins while acquiring this latch. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-Spin").
    /* Accumulated locked microseconds; adapter sums rows and divides by 1,000,000. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-LockT").
    /* Accumulated wait-or-spin microseconds; adapter sums rows and divides by 1,000,000. */
    RUN addField(INPUT rowObject, INPUT BUFFER bLatch:HANDLE, INPUT "_Latch-WaitT").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Database-startup-parameters-file-status-_DbParams.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureDbParams:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE fieldHandle AS HANDLE NO-UNDO.
  DEFINE VARIABLE parameterName AS CHARACTER NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_DBPARAMS} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bDbParams NO-LOCK:
    /* Configuration name selects exactly the original seven metric parameters. */
    fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-Name") NO-ERROR.
    IF NOT VALID-HANDLE(fieldHandle) THEN NEXT.
    parameterName = TRIM(STRING(fieldHandle:BUFFER-VALUE)).
    IF NOT CAN-DO("-B,-B2,-bithold,-basetable,-tablerangesize,-baseindex,-indexrangesize", parameterName) THEN NEXT.
    rowObject = NEW JsonObject().
    /* Command-line or parameter-file configuration name; normal metrics retain only seven approved names. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbParams:HANDLE, INPUT "_DbParams-Name").
    /* Current reported parameter value; ordinary metrics preserve STRING/TRIM conversion. */
    RUN addField(INPUT rowObject, INPUT BUFFER bDbParams:HANDLE, INPUT "_DbParams-Value").
    rowObject:Add("parameter", parameterName).
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Raw meanings: https://docs.progress.com/bundle/openedge-database-management-128/page/Transaction-_Trans.html
   Activity counters retain database statistics-reset semantics; values are not deltas. */
PROCEDURE captureTrans:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_TRANS} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bTrans NO-LOCK:
    rowObject = NEW JsonObject().
    /* Transaction duration in seconds; adapter takes maximum and counts all returned rows, without state filtering. */
    RUN addField(INPUT rowObject, INPUT BUFFER bTrans:HANDLE, INPUT "_Trans-Duration").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.

/* Full configuration capture; raw field reference: https://docs.progress.com/bundle/openedge-database-management-128/page/Database-startup-parameters-file-status-_DbParams.html */
PROCEDURE captureParameterSnapshot:
  DEFINE VARIABLE resultObject AS JsonObject NO-UNDO.
  DEFINE VARIABLE resultRows AS JsonArray NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
&IF {&PB_HAS_DBPARAMS} = 1 &THEN
  DEFINE QUERY parameterQuery FOR bDbParams.
&ENDIF
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

  attemptTime = ISO-DATE(NOW).
  resultObject = NEW JsonObject().
  resultRows = NEW JsonArray().
&IF {&PB_HAS_DBPARAMS} = 1 &THEN
  DO ON ERROR UNDO, THROW:
    OPEN QUERY parameterQuery FOR EACH bDbParams NO-LOCK.
    CATCH queryError AS Progress.Lang.Error:
      captureStatus = "unavailable".
      captureReason = "dbparams_query_unavailable".
    END CATCH.
  END.
  IF captureStatus <> "unavailable" THEN DO:
        GET FIRST parameterQuery.
        DO WHILE NOT QUERY parameterQuery:QUERY-OFF-END:
          IF resultRows:Length >= 1024 THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_row_limit_exceeded".
            LEAVE.
          END.
          /* Command-line/PF configuration name; repeated names and all names are retained. */
          fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-Name") NO-ERROR.
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
          /* Current reported value; full capture retains nullable raw STRING values and byte limits. */
          fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-Value") NO-ERROR.
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
          /* Reported parameter data type code, matching metaschema _Field._dtype; unknown stays null. */
          fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-dtype") NO-ERROR.
          rowDtype = ?.
          IF VALID-HANDLE(fieldHandle) THEN rowDtype = INTEGER(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("dtype", rowDtype).
          /* Whether current value equals default; unknown flag makes capture partial after retaining the row. */
          fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-Is-Default") NO-ERROR.
          defaultValue = ?.
          IF VALID-HANDLE(fieldHandle) THEN defaultValue = LOGICAL(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("isDefault", defaultValue).
          IF defaultValue = ? THEN DO:
            captureStatus = "partial".
            captureReason = "dbparams_default_flag_unavailable:" + rowName.
          END.
          /* Whether this parameter can change at runtime; missing or unknown remains null. */
          fieldHandle = BUFFER bDbParams:BUFFER-FIELD("_DbParams-Is-Modifiable") NO-ERROR.
          modifiableValue = ?.
          IF VALID-HANDLE(fieldHandle) THEN modifiableValue = LOGICAL(fieldHandle:BUFFER-VALUE) NO-ERROR.
          rowObject:Add("isModifiable", modifiableValue).
          resultRows:Add(rowObject).
          GET NEXT parameterQuery.
        END.
    CLOSE QUERY parameterQuery.
  END.
&ELSE
  captureStatus = "unavailable".
  captureReason = "dbparams_source_unavailable".
&ENDIF
  resultObject:Add("contractVersion", "openedge-db-parameter-capture.v1").
  resultObject:Add("databaseName", PDBNAME("DICTDB")).
  resultObject:Add("attemptedAt", attemptTime).
  resultObject:Add("source", "_DbParams").
  resultObject:Add("status", captureStatus).
  IF captureStatus <> "unavailable" AND (captureStatus = "complete" OR resultRows:Length > 0) THEN
    resultObject:Add("capturedAt", ISO-DATE(NOW)).
  IF captureStatus <> "complete" THEN resultObject:Add("reason", captureReason).
  resultObject:Add("rows", resultRows).
  RUN emitJson(INPUT resultObject).
END PROCEDURE.

/* Effective allocated capacity includes reserved database buffers.
   https://docs.progress.com/bundle/openedge-database-management-122/page/Buffer-status-_BuffStatus.html */
PROCEDURE captureBuffStatus:
  DEFINE OUTPUT PARAMETER rows AS JsonArray NO-UNDO.
  DEFINE OUTPUT PARAMETER sourceExists AS LOGICAL NO-UNDO.
  DEFINE VARIABLE rowObject AS JsonObject NO-UNDO.
  rows = NEW JsonArray().
  sourceExists = FALSE.
&IF {&PB_HAS_BUFFSTATUS} = 1 &THEN
  sourceExists = TRUE.
  FOR EACH bBuffStatus NO-LOCK:
    rowObject = NEW JsonObject().
    /* Actual total allocation of primary and alternate buffers, including reserved buffers. */
    RUN addField(INPUT rowObject, INPUT BUFFER bBuffStatus:HANDLE, INPUT "_BfStatus-TotBufs").
    rows:Add(rowObject).
  END.
&ENDIF
END PROCEDURE.
