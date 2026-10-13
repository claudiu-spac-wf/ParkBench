/* Safe fixture: intentionally exceeds the one-minute cooperative deadline. */
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.

DO WHILE TRUE:
    PAUSE 1 NO-MESSAGE.
END.
