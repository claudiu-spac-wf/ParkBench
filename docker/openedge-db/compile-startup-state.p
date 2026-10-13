COMPILE "/usr/local/lib/parkbench/parkbench-db-startup-state.p" SAVE NO-ERROR.
IF COMPILER:ERROR THEN RETURN ERROR "startup_state_compile_failed".
QUIT.
