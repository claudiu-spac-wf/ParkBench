BLOCK-LEVEL ON ERROR UNDO, THROW.
DEFINE VARIABLE errorFile AS CHARACTER NO-UNDO.
DEFINE VARIABLE failed AS LOGICAL NO-UNDO.
errorFile = LDBNAME(1) + ".e".
OS-DELETE VALUE(errorFile).
DO ON ERROR UNDO, THROW:
  RUN prodict/load_df.p (INPUT SESSION:PARAMETER).
  CATCH failure AS Progress.Lang.Error:
    failed = TRUE.
    MESSAGE failure:GetMessage(1).
  END CATCH.
END.
FILE-INFO:FILE-NAME = errorFile.
IF FILE-INFO:FULL-PATHNAME <> ? AND FILE-INFO:FILE-SIZE > 0 THEN DO:
  failed = TRUE.
  MESSAGE "compiler_schema_load_errors".
END.
IF NOT failed THEN DO:
  OUTPUT TO .parkbench-schema-loaded.
  PUT UNFORMATTED "OK" SKIP.
  OUTPUT CLOSE.
END.
QUIT.
