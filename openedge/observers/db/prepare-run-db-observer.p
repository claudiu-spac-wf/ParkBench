DEFINE STREAM sourceInput.
DEFINE STREAM sourceOutput.
/* Raw default: prepare only this packaged observer for the connected schema.
   Caller parameters select collection mode, never a source file. */
DEFINE VARIABLE preparedPath AS CHARACTER NO-UNDO.
DEFINE VARIABLE compiledPath AS CHARACTER NO-UNDO.
DEFINE VARIABLE runFailed AS LOGICAL NO-UNDO.
DEFINE VARIABLE failureReason AS CHARACTER NO-UNDO.
preparedPath = SESSION:TEMP-DIRECTORY + "parkbench-db-observer-" + GUID(GENERATE-UUID) + ".p".
compiledPath = SUBSTRING(preparedPath, 1, LENGTH(preparedPath) - 2) + ".r".
DO ON ERROR UNDO, THROW:
  RUN prepareObserverSource(INPUT "/app/openedge/observers/db/parkbench-db-observer-v2.p", INPUT preparedPath).
  COMPILE VALUE(preparedPath) SAVE NO-ERROR.
  IF COMPILER:ERROR THEN DO:
    runFailed = TRUE.
    failureReason = "openedge_db_observer_compile_failed".
  END.
  ELSE DO:
    /* RUN retains SESSION:PARAMETER for normal versus parameter-capture mode. */
    RUN VALUE(compiledPath) NO-ERROR.
    IF RETURN-VALUE <> ? AND RETURN-VALUE <> "" THEN DO:
      runFailed = TRUE.
      failureReason = RETURN-VALUE.
    END.
  END.
  CATCH preparationError AS Progress.Lang.Error:
    runFailed = TRUE.
    failureReason = "openedge_db_observer_preparation_failed".
  END CATCH.
  FINALLY:
    /* Remove only this invocation's UUID files, even after a failed compile/run. */
    OS-DELETE VALUE(preparedPath).
    OS-DELETE VALUE(compiledPath).
  END FINALLY.
END.
IF runFailed THEN RETURN ERROR failureReason.

PROCEDURE prepareObserverSource:
  DEFINE INPUT PARAMETER originalPath AS CHARACTER NO-UNDO.
  DEFINE INPUT PARAMETER preparedPath AS CHARACTER NO-UNDO.
  DEFINE VARIABLE sourceLine AS CHARACTER NO-UNDO.
  /* Static schema inspection profiles table presence, never patch guesses.
     Optional columns are checked on bound handles by the collector itself. */
  DO ON ERROR UNDO, THROW:
    INPUT STREAM sourceInput FROM VALUE(originalPath).
    OUTPUT STREAM sourceOutput TO VALUE(preparedPath).
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_DBSTATUS "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_DbStatus") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTBUFFER "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActBuffer") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_BUFFSTATUS "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_BuffStatus") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTSUMMARY "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActSummary") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_TABLESTAT "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_TableStat") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_INDEXSTAT "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_IndexStat") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_CHECKPOINT "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_Checkpoint") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTPWS "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActPWs") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTBILOG "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActBILog") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_LOGGING "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_Logging") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTIOTYPE "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActIOType") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_ACTLOCK "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_ActLock") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_LATCH "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_Latch") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_DBPARAMS "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_DbParams") THEN "1" ELSE "0") SKIP.
    PUT STREAM sourceOutput UNFORMATTED "&GLOBAL-DEFINE PB_HAS_TRANS "
      (IF CAN-FIND(FIRST _File WHERE _File._File-Name = "_Trans") THEN "1" ELSE "0") SKIP.
    REPEAT:
      IMPORT STREAM sourceInput UNFORMATTED sourceLine.
      PUT STREAM sourceOutput UNFORMATTED sourceLine SKIP.
    END.
    FINALLY:
      INPUT STREAM sourceInput CLOSE.
      OUTPUT STREAM sourceOutput CLOSE.
    END FINALLY.
  END.
END PROCEDURE.
