/* Safe fixture: non-cooperative loop used to exercise the client no-response
   boundary; the owning run must stop sending work after the deadline. */
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.

DO WHILE TRUE:
    PROCESS EVENTS.
END.
