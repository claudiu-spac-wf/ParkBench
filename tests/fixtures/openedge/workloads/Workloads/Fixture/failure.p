/* Safe fixture: deterministic application failure for error translation tests. */
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.

RETURN ERROR "fixture_failure".
