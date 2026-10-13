/* Compile only in a disposable validation copy to exercise the assignment witness. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE SingleParam AS LONGCHAR NO-UNDO.
&GLOBAL-DEFINE PB-WRITE-WITNESS TRUE
&SCOPED-DEFINE PB-TABLE Employee
{write-common.i}
{write-inventory.i}
pbIgnored = pbLoadInventory().
pbNewId = 1.
pbIgnored = pbWitness("JobTitle", "ordinary").
pbIgnored = pbWitness("Photo", "lob").
QUIT.
