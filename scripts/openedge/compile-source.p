DEFINE STREAM sourceInput.
DEFINE STREAM sourceOutput.
/* Compile workload sources unchanged; profile only the named v2 observer. */
DEFINE VARIABLE sourcePath AS CHARACTER NO-UNDO.
DEFINE VARIABLE sourceDirectory AS CHARACTER NO-UNDO.
DEFINE VARIABLE preparedDirectory AS CHARACTER NO-UNDO.
DEFINE VARIABLE preparedPath AS CHARACTER NO-UNDO.
DEFINE VARIABLE failed AS LOGICAL NO-UNDO.
sourcePath = SESSION:PARAMETER.
IF sourcePath = "" OR sourcePath = ? THEN RETURN ERROR "compile_source_required".
IF ENTRY(NUM-ENTRIES(sourcePath, "/"), sourcePath, "/") = "parkbench-db-observer-v2.p" THEN DO:
  sourceDirectory = SUBSTRING(sourcePath, 1, R-INDEX(sourcePath, "/") - 1).
  preparedDirectory = sourceDirectory + "/.parkbench-profile-" + GUID(GENERATE-UUID).
  preparedPath = preparedDirectory + "/parkbench-db-observer-v2.p".
  DO ON ERROR UNDO, THROW:
    OS-CREATE-DIR VALUE(preparedDirectory).
    IF OS-ERROR <> 0 THEN UNDO, THROW NEW Progress.Lang.AppError("observer_profile_directory_failed", 0).
    RUN prepareObserverSource(INPUT sourcePath, INPUT preparedPath).
    COMPILE VALUE(preparedPath) SAVE INTO VALUE(sourceDirectory) NO-ERROR.
    IF COMPILER:ERROR THEN failed = TRUE.
    FINALLY:
      OS-DELETE VALUE(preparedPath).
      OS-DELETE VALUE(preparedDirectory + "/parkbench-db-observer-v2.r").
      OS-DELETE VALUE(preparedDirectory).
    END FINALLY.
  END.
END.
ELSE DO:
  COMPILE VALUE(sourcePath) SAVE NO-ERROR.
  failed = COMPILER:ERROR.
END.
IF failed THEN RETURN ERROR "compile_failed".
QUIT.

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
