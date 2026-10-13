DEFINE VARIABLE fixtureText AS LONGCHAR NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_disposable_database_required", 0).
FIND CustomerNote WHERE CustomerNote.CustomerNoteId = 1 EXCLUSIVE-LOCK NO-WAIT.
ASSIGN CustomerNote.Summary = "write fixture " + THIS-PROCEDURE:FILE-NAME.
FIX-CODEPAGE(fixtureText) = "UTF-8".
fixtureText = "Write fixture real CLOB content from " + THIS-PROCEDURE:FILE-NAME.
COPY-LOB FROM fixtureText TO CustomerNote.NoteText.
VALIDATE CustomerNote.
