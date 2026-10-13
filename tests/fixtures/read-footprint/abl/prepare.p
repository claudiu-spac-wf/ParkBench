/* Fixture mutations are permitted only in a task-owned empty-schema clone. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE memoryValue AS MEMPTR NO-UNDO.
DEFINE VARIABLE textValue AS LONGCHAR NO-UNDO.
DEFINE VARIABLE i AS INTEGER NO-UNDO.
DEFINE BUFFER originalDebit FOR DebitTransaction.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN UNDO, THROW NEW Progress.Lang.AppError("read_fixture_disposable_database_required", 0).
parser = NEW ObjectModelParser(). config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
DO TRANSACTION:
  FIND FIRST originalDebit NO-LOCK.
  DO i = 1001 TO 3501:
    CREATE DebitTransaction.
    BUFFER-COPY originalDebit EXCEPT DebitTransactionId TO DebitTransaction.
    ASSIGN DebitTransaction.DebitTransactionId = i DebitTransaction.RandomInt1000 = 1.
    RELEASE DebitTransaction.
  END.
  FIND FIRST CustomerDocument EXCLUSIVE-LOCK WHERE CustomerDocumentId = 1.
  SET-SIZE(memoryValue) = 5.
  DO i = 1 TO 5: PUT-BYTE(memoryValue, i) = IF i = 1 THEN 0 ELSE IF i = 2 THEN 255 ELSE i. END.
  COPY-LOB FROM memoryValue TO CustomerDocument.Content.
  CustomerDocument.FileSizeBytes = 5. SET-SIZE(memoryValue) = 0.
  RELEASE CustomerDocument.
  FIND FIRST CustomerDocument EXCLUSIVE-LOCK WHERE CustomerDocumentId = 2.
  COPY-LOB FROM FILE "/validation/empty.bin" TO CustomerDocument.Content.
  CustomerDocument.FileSizeBytes = 0. RELEASE CustomerDocument.
  FIND FIRST CustomerDocument EXCLUSIVE-LOCK WHERE CustomerDocumentId = 3.
  CustomerDocument.Content = ?. CustomerDocument.FileSizeBytes = 0. RELEASE CustomerDocument.
  FIX-CODEPAGE(textValue) = "UTF-8".
  textValue = "A" + CHR(233).
  FIND FIRST CustomerNote EXCLUSIVE-LOCK WHERE CustomerNoteId = 1.
  COPY-LOB FROM textValue TO CustomerNote.NoteText. RELEASE CustomerNote.
  textValue = "".
  FIND FIRST CustomerNote EXCLUSIVE-LOCK WHERE CustomerNoteId = 2.
  COPY-LOB FROM textValue TO CustomerNote.NoteText. RELEASE CustomerNote.
  FIND FIRST CustomerNote EXCLUSIVE-LOCK WHERE CustomerNoteId = 3.
  CustomerNote.NoteText = ?. RELEASE CustomerNote.
END.
result = NEW JsonObject(). result:Add("ok", TRUE). result:Add("extraDebitRecords", 2501).
result:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
FINALLY:
  SET-SIZE(memoryValue) = 0.
END FINALLY.
