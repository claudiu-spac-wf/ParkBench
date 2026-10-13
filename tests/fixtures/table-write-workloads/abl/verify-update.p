/* Native selective update invocation with an explicit transaction outcome in test evidence. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE payload AS LONGCHAR NO-UNDO.
DEFINE VARIABLE i AS INTEGER NO-UNDO.
DEFINE VARIABLE diagnostic AS CHARACTER NO-UNDO.
IF OS-GETENV("PARKBENCH_WRITE_FIXTURE") <> "1" THEN
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_disposable_database_required", 0).
parser = NEW ObjectModelParser().
config = CAST(parser:Parse(SESSION:PARAMETER), JsonObject).
config:GetJsonObject("input"):Write(payload).
result = NEW JsonObject().
DO ON ERROR UNDO, THROW:
  DO TRANSACTION ON ERROR UNDO, THROW:
    RUN VALUE("Workloads/Write/" + config:GetCharacter("table") + ".p") (payload).
  END.
  result:Add("ok", TRUE).
  CATCH failure AS Progress.Lang.Error:
    result:Add("ok", FALSE).
    DO i = 1 TO failure:NumMessages:
      diagnostic = diagnostic + (IF i > 1 THEN " | " ELSE "") + failure:GetMessage(i).
    END.
    IF diagnostic = "" AND TYPE-OF(failure, Progress.Lang.AppError) THEN diagnostic = CAST(failure, Progress.Lang.AppError):ReturnValue.
    result:Add("error", diagnostic).
    result:Add("messageCount", failure:NumMessages).
  END CATCH.
END.
result:WriteFile(config:GetCharacter("report"), TRUE).
QUIT.
