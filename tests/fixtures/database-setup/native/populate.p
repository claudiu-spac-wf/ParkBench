DEFINE VARIABLE n AS INTEGER NO-UNDO.
DO n = 1 TO 2000:
 CREATE SetupCustomer. SetupCustomer.Id = n.
 CREATE SetupOrder. SetupOrder.Id = n.
END.
QUIT.
