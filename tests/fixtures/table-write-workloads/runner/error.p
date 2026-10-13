/* Temporary runner fixture; never packaged as a production workload. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
DO TRANSACTION ON ERROR UNDO, THROW:
  {Workloads/Write/Fixture/common-write.i}
  UNDO, THROW NEW Progress.Lang.AppError("write_fixture_forced_error", 0).
END.
