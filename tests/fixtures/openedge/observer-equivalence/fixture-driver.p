/* Standalone T009 transformation probe: run through the helper, not directly.
   Fixture JSON format for later cases: sources map contains present, fields
   (ABL scalar type by raw field name) and ordered rows (null means unknown).
   Metadata fixture arrays contain original table numbers/names/types and
   index numbers/names with owner table numbers; driver assigns owner RECIDs.
   A field absent from fields is not the same as a null value in a row. */
USING Progress.Json.ObjectModel.JsonObject.

DEFINE TEMP-TABLE fixtureDbStatus NO-UNDO LIKE _DbStatus.
DEFINE TEMP-TABLE fixtureDbParams NO-UNDO LIKE _DbParams.
DEFINE TEMP-TABLE fixtureFile NO-UNDO
  FIELD tableNumber AS INTEGER
  FIELD tableName AS CHARACTER
  FIELD tableType AS CHARACTER
  INDEX tableNumber tableNumber.
DEFINE TEMP-TABLE fixtureIndex NO-UNDO
  FIELD indexNumber AS INTEGER
  FIELD indexName AS CHARACTER
  FIELD sourceFileRecid AS RECID
  INDEX indexNumber indexNumber.
DEFINE TEMP-TABLE copiedFile NO-UNDO
  FIELD tableNumber AS INTEGER
  FIELD tableName AS CHARACTER
  FIELD tableType AS CHARACTER
  FIELD sourceRecid AS RECID
  INDEX identity IS UNIQUE sourceRecid.
/* This binding must be transformed to fixtureDbStatus by T005's tokenizer. */
DEFINE BUFFER bProbeDbStatus FOR _DbStatus.
DEFINE VARIABLE bufferHandle AS HANDLE NO-UNDO.
DEFINE VARIABLE databaseBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE sourceName AS CHARACTER NO-UNDO INITIAL "_DbStatus".
DEFINE VARIABLE counter AS INTEGER NO-UNDO.
DEFINE VARIABLE expectedOwner AS RECID NO-UNDO.
DEFINE VARIABLE resultObject AS JsonObject NO-UNDO.
DEFINE VARIABLE resultText AS LONGCHAR NO-UNDO.
DEFINE VARIABLE resultChunk AS CHARACTER NO-UNDO.

CREATE fixtureDbStatus.
fixtureDbStatus._DbStatus-BiSize = 917.
CREATE fixtureDbParams.
fixtureDbParams._DbParams-Name = "probe-parameter".
CREATE fixtureFile.
ASSIGN fixtureFile.tableNumber = 917
       fixtureFile.tableName = "FixtureOwner"
       fixtureFile.tableType = "T"
       expectedOwner = RECID(fixtureFile).
CREATE fixtureIndex.
ASSIGN fixtureIndex.indexNumber = 918
       fixtureIndex.indexName = "FixtureIndex"
       fixtureIndex.sourceFileRecid = expectedOwner.
/* Force the copied record to have a different identity even on an AVM whose
   initial temp-table RECIDs coincide across tables. */
DO counter = 1 TO 20:
  CREATE copiedFile.
  copiedFile.sourceRecid = counter + 10000.
END.
CREATE copiedFile.
BUFFER-COPY fixtureFile TO copiedFile.
copiedFile.sourceRecid = expectedOwner.

RELEASE fixtureDbStatus.
RELEASE fixtureDbParams.

/* Both exact legacy buffer-creation anchors exercise the same transformation
   function used for the SHA-checked full original collector. */
CREATE BUFFER bufferHandle FOR TABLE sourceName NO-ERROR.
CREATE BUFFER databaseBuffer FOR TABLE "_DbParams" NO-ERROR.
IF NOT VALID-HANDLE(bufferHandle) OR NOT VALID-HANDLE(databaseBuffer) THEN DO:
  PUT UNFORMATTED "fixture_probe_buffer_missing: " ERROR-STATUS:GET-MESSAGE(1) SKIP.
  RETURN.
END.
bufferHandle:FIND-FIRST() NO-ERROR.
databaseBuffer:FIND-FIRST() NO-ERROR.
FIND FIRST bProbeDbStatus NO-LOCK NO-ERROR.
IF NOT AVAILABLE bProbeDbStatus THEN DO:
  PUT UNFORMATTED "fixture_probe_static_missing: " ERROR-STATUS:GET-MESSAGE(1) SKIP.
  RETURN.
END.
FIND FIRST copiedFile WHERE copiedFile.sourceRecid = fixtureIndex.sourceFileRecid NO-ERROR.
IF NOT AVAILABLE copiedFile THEN DO:
  PUT UNFORMATTED "fixture_probe_owner_missing" SKIP.
  RETURN.
END.
resultObject = NEW JsonObject().
resultObject:Add("dynamicSentinel", DECIMAL(bufferHandle:BUFFER-FIELD("_DbStatus-BiSize"):BUFFER-VALUE)).
resultObject:Add("staticSentinel", DECIMAL(BUFFER bProbeDbStatus:HANDLE:BUFFER-FIELD("_DbStatus-BiSize"):BUFFER-VALUE)).
resultObject:Add("parameterSentinel", STRING(databaseBuffer:BUFFER-FIELD("_DbParams-Name"):BUFFER-VALUE)).
resultObject:Add("tableName", copiedFile.tableName).
resultObject:Add("originalOwnerPreserved", copiedFile.sourceRecid = expectedOwner).
resultObject:Add("copiedIdentityDiffers", RECID(copiedFile) <> expectedOwner).
resultObject:Write(INPUT-OUTPUT resultText).
resultChunk = SUBSTRING(resultText, 1, 30000).
PUT UNFORMATTED resultChunk SKIP.
DELETE OBJECT bufferHandle.
DELETE OBJECT databaseBuffer.
RETURN.

PROCEDURE fixtureBuffer:
  DEFINE INPUT PARAMETER nameToBind AS CHARACTER NO-UNDO.
  DEFINE OUTPUT PARAMETER handleToBind AS HANDLE NO-UNDO.
  CASE nameToBind:
    WHEN "_DbStatus" THEN
      CREATE BUFFER handleToBind FOR TABLE "fixtureDbStatus" BUFFER-NAME nameToBind.
    WHEN "_DbParams" THEN
      CREATE BUFFER handleToBind FOR TABLE "fixtureDbParams" BUFFER-NAME nameToBind.
    OTHERWISE RETURN ERROR "fixture_probe_source_unavailable".
  END CASE.
END PROCEDURE.
