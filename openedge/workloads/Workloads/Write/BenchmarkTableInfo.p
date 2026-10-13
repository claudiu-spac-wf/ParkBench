/* Generated fixed-table write workload. Validated policy inventory; do not edit generated source. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
&SCOPED-DEFINE PB-TABLE BenchmarkTableInfo
&SCOPED-DEFINE PB-SCAFFOLD FALSE
{write-common.i}
{write-generators.i}
{write-inventory.i}
CREATE WIDGET-POOL.
DO ON ERROR UNDO, THROW:
  pbIgnored = pbLoadInventory().
  pbIgnored = pbParse().
  IF pbMode = "validate" THEN DO:
    pbIgnored = pbReadiness().
    RETURN.
  END.
  IF {&PB-SCAFFOLD} THEN UNDO, THROW NEW Progress.Lang.AppError("table_write_not_ready", 0).
  IF pbOperation = "update" THEN pbIgnored = pbPrepareQuery().
  IF pbLimit = 0 THEN RETURN.
  DO TRANSACTION ON ERROR UNDO, THROW:
    IF pbOperation = "create" THEN DO:
      {write-create.i}
    END.
    ELSE DO:
      {write-update.i}
    END.
  END.
  FINALLY:
    pbIgnored = pbCleanup().
  END FINALLY.
END.
