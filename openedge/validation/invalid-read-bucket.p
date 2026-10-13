/* Intentionally invalid data belongs only to the disposable empty-schema fixture. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN UNDO, THROW NEW Progress.Lang.AppError("invalid_read_fixture_required", 0).
parser = NEW ObjectModelParser(). config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
DO TRANSACTION:
  FIND FIRST Account EXCLUSIVE-LOCK.
  Account.RandomInt1000 = IF config:IsNull("bucket") THEN ? ELSE config:GetInteger("bucket").
END.
result = NEW JsonObject(). result:Add("ok", TRUE).
result:WriteFile(config:GetCharacter("report"), TRUE). QUIT.
