/* Temporary runner fixture; never packaged as a production workload. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
DO TRANSACTION ON ERROR UNDO, THROW:
  {Workloads/Write/Fixture/common-write.i}
  
END.
