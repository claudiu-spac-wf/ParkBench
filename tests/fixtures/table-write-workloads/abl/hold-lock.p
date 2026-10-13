BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE evidence AS JsonObject NO-UNDO.
DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
DEFINE VARIABLE succeeded AS LOGICAL NO-UNDO.
DEFINE VARIABLE deadline AS INTEGER NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_disposable_database_required", 0).
parser = NEW ObjectModelParser().
config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
CREATE BUFFER hBuffer FOR TABLE config:GetCharacter("table").
DO TRANSACTION ON ERROR UNDO, THROW:
  ASSIGN succeeded = hBuffer:FIND-FIRST("WHERE " + config:GetCharacter("where"), EXCLUSIVE-LOCK, NO-WAIT) NO-ERROR.
  IF succeeded <> TRUE OR ERROR-STATUS:NUM-MESSAGES > 0 OR hBuffer:LOCKED THEN
    UNDO, THROW NEW Progress.Lang.AppError("write_fixture_lock_failed", 0).
  evidence = NEW JsonObject().
  evidence:Add("locked", TRUE).
  evidence:WriteFile(config:GetCharacter("ready"), TRUE).
  deadline = ETIME + 90000.
  REPEAT:
    FILE-INFO:FILE-NAME = config:GetCharacter("release").
    IF FILE-INFO:FULL-PATHNAME <> ? THEN LEAVE.
    IF ETIME > deadline THEN UNDO, THROW NEW Progress.Lang.AppError("write_fixture_lock_release_missing", 0).
    PAUSE 1 NO-MESSAGE.
  END.
END.
QUIT.
