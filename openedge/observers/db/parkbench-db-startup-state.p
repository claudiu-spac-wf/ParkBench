/* Bounded read-only state. Native APW/BIW membership and PIDs are scoped by this DB connection.
   Field references: Progress 12.8 _Connect, _DbStatus and _DbParams VST documentation. */
USING Progress.Json.ObjectModel.*.
DEFINE VARIABLE state AS JsonObject NO-UNDO.
DEFINE VARIABLE writers AS JsonArray NO-UNDO.
DEFINE VARIABLE writer AS JsonObject NO-UNDO.
DEFINE VARIABLE apws AS INTEGER NO-UNDO.
DEFINE VARIABLE biws AS INTEGER NO-UNDO.
DEFINE VARIABLE clusterKiB AS INTEGER NO-UNDO.
DEFINE VARIABLE biBuffers AS INTEGER NO-UNDO.
DEFINE VARIABLE capacity AS INTEGER NO-UNDO.
DEFINE VARIABLE apwPids AS CHARACTER NO-UNDO.
DEFINE VARIABLE biwPids AS CHARACTER NO-UNDO.
DEFINE VARIABLE prefix AS CHARACTER NO-UNDO.
DEFINE VARIABLE kind AS CHARACTER NO-UNDO.
DEFINE VARIABLE connectionCount AS INTEGER NO-UNDO.
prefix = SESSION:PARAMETER.
IF prefix = ? OR prefix = "" THEN RETURN ERROR "startup_state_output_required".
state = NEW JsonObject().
writers = NEW JsonArray().
FOR EACH _DbStatus NO-LOCK:
  clusterKiB = _DbStatus-BiClSize.
END.
FOR EACH _DbParams NO-LOCK:
  IF _DbParams-Name = "-bibufs" THEN biBuffers = INTEGER(_DbParams-Value).
  /* Comparisons are case-insensitive in ABL; -N is a network protocol, not -n. */
  IF LENGTH(_DbParams-Name) = 2 AND SUBSTRING(_DbParams-Name, 1, 1) = "-"
    AND ASC(SUBSTRING(_DbParams-Name, 2, 1)) = ASC("n") THEN capacity = INTEGER(_DbParams-Value).
END.
FOR EACH _Connect NO-LOCK WHERE _Connect-Pid > 0:
  connectionCount = connectionCount + 1.
  kind = TRIM(_Connect-Type).
  IF kind <> "APW" AND kind <> "BIW" THEN NEXT.
  IF writers:Length >= 16 THEN RETURN ERROR "startup_writer_inventory_overflow".
  writer = NEW JsonObject().
  writer:Add("type", kind).
  writer:Add("pid", _Connect-Pid).
  writer:Add("connectionId", _Connect-Usr).
  writers:Add(writer).
  IF kind = "APW" THEN DO:
    apws = apws + 1.
    apwPids = apwPids + (IF apwPids = "" THEN "" ELSE ",") + STRING(_Connect-Pid).
  END.
  ELSE DO:
    biws = biws + 1.
    biwPids = biwPids + (IF biwPids = "" THEN "" ELSE ",") + STRING(_Connect-Pid).
  END.
END.
state:Add("contractVersion", "db-startup-state.v1").
state:Add("capturedAt", NOW).
state:Add("nativeClusterKiB", clusterKiB).
state:Add("biBuffers", biBuffers).
state:Add("connectionCapacity", capacity).
state:Add("connectedCount", connectionCount).
state:Add("apwCount", apws).
state:Add("biwCount", biws).
state:Add("writers", writers).
state:WriteFile(prefix + ".json", TRUE).
OUTPUT TO VALUE(prefix + ".env").
PUT UNFORMATTED "clusterKiB=" clusterKiB SKIP "biBuffers=" biBuffers SKIP
  "capacity=" capacity SKIP "apwCount=" apws SKIP "biwCount=" biws SKIP
  "apwPids=" apwPids SKIP "biwPids=" biwPids SKIP.
OUTPUT CLOSE.
QUIT.
