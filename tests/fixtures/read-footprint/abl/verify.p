/* Independent exact byte/ID oracle; never calls the histogram calculator. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE cases AS JsonArray NO-UNDO.
DEFINE VARIABLE entryValue AS JsonObject NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE convertedValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE expectedBytes AS INTEGER NO-UNDO.
DEFINE VARIABLE countValue AS INTEGER NO-UNDO.
DEFINE VARIABLE lastId AS INTEGER NO-UNDO.
DEFINE VARIABLE recordTotal AS INT64 NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_disposable_database_required", 0).
parser = NEW ObjectModelParser(). config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
cases = NEW JsonArray().
FOR EACH CustomerDocument NO-LOCK WHERE CustomerDocumentId <= 3 BY CustomerDocumentId:
  expectedBytes = IF CustomerDocumentId = 1 THEN 5 ELSE 0. SET-SIZE(memoryValue) = 0.
  IF CustomerDocumentId = 3 THEN DO:
    IF CustomerDocument.Content <> ? THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_unknown_blob_failed", 0).
  END.
  ELSE COPY-LOB FROM CustomerDocument.Content TO memoryValue NO-CONVERT.
  IF GET-SIZE(memoryValue) <> expectedBytes THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_blob_bytes_failed", 0).
  IF CustomerDocumentId = 1 AND (GET-BYTE(memoryValue, 1) <> 0 OR GET-BYTE(memoryValue, 2) <> 255) THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_binary_payload_failed", 0).
  entryValue = NEW JsonObject(). entryValue:Add("table", "CustomerDocument"). entryValue:Add("id", CustomerDocumentId).
  entryValue:Add("expectedBytes", expectedBytes). entryValue:Add("actualBytes", GET-SIZE(memoryValue)).
  entryValue:Add("recordBytes", BUFFER CustomerDocument:HANDLE:RECORD-LENGTH). cases:Add(entryValue).
  SET-SIZE(memoryValue) = 0.
END.
FOR EACH CustomerNote NO-LOCK WHERE CustomerNoteId <= 3 BY CustomerNoteId:
  expectedBytes = IF CustomerNoteId = 1 THEN 3 ELSE 0. SET-SIZE(memoryValue) = 0.
  IF CustomerNoteId = 3 THEN DO:
    IF CustomerNote.NoteText <> ? THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_unknown_clob_failed", 0).
  END.
  ELSE COPY-LOB FROM CustomerNote.NoteText TO memoryValue NO-CONVERT.
  IF GET-SIZE(memoryValue) <> expectedBytes THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_utf8_bytes_failed", 0).
  IF CustomerNoteId = 1 AND (GET-BYTE(memoryValue, 1) <> 65 OR GET-BYTE(memoryValue, 2) <> 195 OR GET-BYTE(memoryValue, 3) <> 169) THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_utf8_encoding_failed", 0).
  entryValue = NEW JsonObject(). entryValue:Add("table", "CustomerNote"). entryValue:Add("id", CustomerNoteId).
  entryValue:Add("expectedBytes", expectedBytes). entryValue:Add("actualBytes", GET-SIZE(memoryValue)).
  entryValue:Add("recordBytes", BUFFER CustomerNote:HANDLE:RECORD-LENGTH). cases:Add(entryValue).
  SET-SIZE(memoryValue) = 0.
END.
FOR EACH DebitTransaction NO-LOCK WHERE DebitTransactionId >= 1001:
  countValue = countValue + 1. lastId = MAXIMUM(lastId, DebitTransactionId).
  recordTotal = recordTotal + BUFFER DebitTransaction:HANDLE:RECORD-LENGTH.
END.
IF countValue <> 2501 OR lastId <> 3501 THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_reachability_ids_failed", 0).
result = NEW JsonObject(). result:Add("ok", TRUE). result:Add("cases", cases).
result:Add("extraDebitRecords", countValue). result:Add("lastDebitId", lastId). result:Add("extraDebitRecordBytes", recordTotal).
result:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
FINALLY:
  SET-SIZE(memoryValue) = 0. SET-SIZE(convertedValue) = 0.
END FINALLY.
