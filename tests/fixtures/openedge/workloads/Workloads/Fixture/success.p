/* Safe fixture: validates that the dispatcher passed the JSON value through
   the single LONGCHAR parameter before completing successfully. */
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.

IF INDEX(SingleParam, '"marker":"parkbench"') = 0 THEN
    RETURN ERROR "fixture_input_not_received".
