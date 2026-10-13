/* Generic PASOE WEB handler. Business workloads are supplied separately below
   Workloads/ and are not part of the dispatcher implementation. */
BLOCK-LEVEL ON ERROR UNDO, THROW.

USING OpenEdge.Core.String.
USING OpenEdge.Net.HTTP.Filter.Payload.MessageWriter.
USING OpenEdge.Net.HTTP.Filter.Payload.StringEntityWriter.
USING OpenEdge.Net.HTTP.IHttpResponse.
USING OpenEdge.Net.HTTP.StatusCodeEnum.
USING OpenEdge.Web.IWebRequest.
USING OpenEdge.Web.WebHandler.
USING OpenEdge.Web.WebResponse.
USING OpenEdge.Web.WebResponseWriter.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
USING Progress.Lang.Error.
USING Progress.Lang.Stop.

CLASS ParkBenchWorkHandler INHERITS WebHandler:

    METHOD OVERRIDE PROTECTED INTEGER HandleNotAllowedMethod(INPUT poRequest AS IWebRequest):
        RETURN INTEGER(StatusCodeEnum:MethodNotAllowed).
    END METHOD.

    METHOD OVERRIDE PROTECTED INTEGER HandleNotImplemented(INPUT poRequest AS IWebRequest):
        RETURN INTEGER(StatusCodeEnum:NotImplemented).
    END METHOD.

    METHOD OVERRIDE PROTECTED INTEGER HandleGet(INPUT poRequest AS IWebRequest):
        DEFINE VARIABLE oBody AS JsonObject NO-UNDO.
        DEFINE VARIABLE routePath AS CHARACTER NO-UNDO.

        oBody = NEW JsonObject().
        routePath = RequestPath(poRequest).
        CASE routePath:
            WHEN "/health" THEN DO:
                oBody:Add("status", "ok").
                oBody:Add("service", "parkbench-work-runner").
            END.
            WHEN "/metrics" THEN DO:
                oBody:Add("service", "parkbench-work-runner").
                oBody:Add("contractVersion", "workload-runner.v1").
                oBody:Add("timeoutMs", 60000).
            END.
            OTHERWISE
                RETURN INTEGER(StatusCodeEnum:NotFound).
        END CASE.

        RETURN SendJson(oBody, INTEGER(StatusCodeEnum:OK)).
    END METHOD.

    METHOD OVERRIDE PROTECTED INTEGER HandlePost(INPUT poRequest AS IWebRequest):
        DEFINE VARIABLE requestId AS CHARACTER NO-UNDO.
        DEFINE VARIABLE requestBody AS LONGCHAR NO-UNDO.
        DEFINE VARIABLE procName AS CHARACTER NO-UNDO.
        DEFINE VARIABLE SingleParam AS LONGCHAR NO-UNDO.
        DEFINE VARIABLE payload AS JsonObject NO-UNDO.
        DEFINE VARIABLE parser AS ObjectModelParser NO-UNDO.
        DEFINE VARIABLE names AS CHARACTER EXTENT NO-UNDO.
        DEFINE VARIABLE nameIndex AS INTEGER NO-UNDO.
        DEFINE VARIABLE elapsedMs AS INTEGER NO-UNDO.
        DEFINE VARIABLE procedureCompleted AS LOGICAL NO-UNDO.
        DEFINE VARIABLE procedureTimedOut AS LOGICAL NO-UNDO.
        DEFINE VARIABLE isWriteNamespace AS LOGICAL NO-UNDO.
        DEFINE VARIABLE errorCode AS CHARACTER NO-UNDO.
        DEFINE VARIABLE responseBody AS JsonObject NO-UNDO.
        DEFINE VARIABLE routePath AS CHARACTER NO-UNDO.

        ASSIGN
            requestId = STRING(GENERATE-UUID)
            errorCode = "invalid_json".
        ETIME(TRUE).

        routePath = RequestPath(poRequest).
        IF routePath <> "/work" THEN
            RETURN INTEGER(StatusCodeEnum:NotFound).

        DO ON ERROR UNDO, THROW:
            requestBody = ReadRequestBody(poRequest).
            IF LENGTH(requestBody, "raw") > 1048576 THEN DO:
                ASSIGN errorCode = "invalid_work_request".
                RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:BadRequest)).
            END.

            parser = NEW ObjectModelParser().
            payload = CAST(parser:Parse(requestBody), JsonObject).
            ASSIGN errorCode = "invalid_work_request".
            IF payload:Has("procName") = FALSE OR payload:Has("input") = FALSE THEN
                RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:BadRequest)).

            names = payload:GetNames().
            IF EXTENT(names) <> ? THEN DO nameIndex = 1 TO EXTENT(names):
                IF names[nameIndex] <> "procName" AND names[nameIndex] <> "input" THEN
                    RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:BadRequest)).
            END.

            ASSIGN procName = payload:GetCharacter("procName") NO-ERROR.
            IF ERROR-STATUS:ERROR OR procName = ? THEN
                RETURN SendError("unsafe_proc_name", requestId, INTEGER(StatusCodeEnum:BadRequest)).
            ASSIGN errorCode = "unsafe_proc_name".
            IF NOT IsCanonicalWorkload(procName) THEN
                RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:BadRequest)).

            ASSIGN errorCode = "workload_not_found".
            IF SEARCH(procName) = ? THEN
                RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:NotFound)).

            /* GetJsonText preserves the original JSON value as one compact
               LONGCHAR, including objects, arrays, strings, booleans, numbers,
               and null. */
            SingleParam = payload:GetJsonText("input").
            ASSIGN
                errorCode = "workload_failed"
                procedureCompleted = FALSE
                procedureTimedOut = FALSE.
            isWriteNamespace = procName BEGINS "Workloads/Write/".
            IF isWriteNamespace THEN DO:
                /* A write commits only after the deadline verdict is accepted.
                   Procedure transactions join this boundary. NO-UNDO outcome
                   flags must be cleared explicitly when STOP interrupts RUN. */
                writeExecution:
                DO TRANSACTION STOP-AFTER 60 ON ERROR UNDO, THROW ON STOP UNDO, LEAVE:
                    RUN VALUE(procName) (INPUT SingleParam).
                    IF ETIME >= 60000 THEN DO:
                        ASSIGN procedureTimedOut = TRUE procedureCompleted = FALSE.
                        UNDO writeExecution, LEAVE writeExecution.
                    END.
                    procedureCompleted = TRUE.
                    CATCH writeStop AS Stop:
                        /* The AVM undoes the associated transaction before
                           entering CATCH; only NO-UNDO flags need resetting. */
                        ASSIGN procedureCompleted = FALSE
                            procedureTimedOut = TYPE-OF(writeStop, Progress.Lang.StopAfter).
                    END CATCH.
                END.
            END.
            ELSE DO:
                DO STOP-AFTER 60 ON STOP UNDO, LEAVE:
                    RUN VALUE(procName) (INPUT SingleParam).
                    procedureCompleted = TRUE.
                CATCH stopCondition AS Stop:
                    procedureTimedOut = TYPE-OF(stopCondition, Progress.Lang.StopAfter).
                END CATCH.
                END.
            END.

            elapsedMs = MAXIMUM(0, ETIME).
            IF NOT procedureCompleted THEN DO:
                IF procedureTimedOut OR elapsedMs >= 60000 THEN
                    RETURN SendError("workload_timeout", requestId, INTEGER(StatusCodeEnum:RequestTimeout)).
                RETURN SendError("workload_stopped", requestId, INTEGER(StatusCodeEnum:InternalServerError)).
            END.
            IF NOT isWriteNamespace AND elapsedMs >= 60000 THEN
                RETURN SendError("workload_timeout", requestId, INTEGER(StatusCodeEnum:RequestTimeout)).

            responseBody = NEW JsonObject().
            responseBody:Add("ok", TRUE).
            responseBody:Add("procName", procName).
            responseBody:Add("elapsedMs", elapsedMs).
            responseBody:Add("requestId", requestId).
            RETURN SendJson(responseBody, INTEGER(StatusCodeEnum:OK)).
        END.

        RETURN SendError(errorCode, requestId, INTEGER(StatusCodeEnum:InternalServerError)).

        CATCH error AS Error:
            IF error:NumMessages > 0 AND
               INDEX(error:GetMessage(1), "database_schema_invalid:") = 1 THEN
                errorCode = "database_schema_invalid".
            /* A workload's own error code (RETURN ERROR "<code>") is returned as an optional
               "detail" when it is a short, safe token; "error" keeps the stable class. */
            RETURN SendError(
                IF errorCode = "invalid_json" THEN "invalid_json" ELSE errorCode,
                requestId,
                IF errorCode = "invalid_json" OR errorCode = "invalid_work_request"
                THEN INTEGER(StatusCodeEnum:BadRequest)
                ELSE INTEGER(StatusCodeEnum:InternalServerError),
                IF errorCode = "workload_failed" OR errorCode = "database_schema_invalid"
                THEN WorkloadErrorDetail(error) ELSE "").
        END CATCH.
    END METHOD.

    METHOD PRIVATE CHARACTER RequestPath(INPUT poRequest AS IWebRequest):
        DEFINE VARIABLE routePath AS CHARACTER NO-UNDO.

        routePath = poRequest:URI:Path.
        /* The WEB transport may pass either the operation path or the full
           web-app path to the handler, depending on the adapter context. */
        IF routePath BEGINS "/parkbench/web" THEN
            routePath = SUBSTRING(routePath, LENGTH("/parkbench/web") + 1).
        RETURN routePath.
    END METHOD.

    METHOD PRIVATE LONGCHAR ReadRequestBody(INPUT poRequest AS IWebRequest):
        DEFINE VARIABLE entityWriter AS MessageWriter NO-UNDO.

        entityWriter = NEW StringEntityWriter().
        entityWriter:Open().
        entityWriter:Write(poRequest:Entity).
        entityWriter:Close().
        RETURN CAST(entityWriter:Entity, String):Value.
    END METHOD.

    METHOD PRIVATE LOGICAL IsCanonicalWorkload(INPUT pathValue AS CHARACTER):
        DEFINE VARIABLE segment AS CHARACTER NO-UNDO.
        DEFINE VARIABLE character AS CHARACTER NO-UNDO.
        DEFINE VARIABLE segmentIndex AS INTEGER NO-UNDO.
        DEFINE VARIABLE characterIndex AS INTEGER NO-UNDO.

        IF pathValue = ? OR pathValue = "" OR LENGTH(pathValue) > 512 OR NOT pathValue BEGINS "Workloads/"
            OR INDEX(pathValue, "\\") > 0 OR INDEX(pathValue, "%") > 0 OR INDEX(pathValue, ":") > 0
            OR INDEX(pathValue, "//") > 0 OR pathValue BEGINS "/"
            OR SUBSTRING(pathValue, LENGTH(pathValue), 1) = "/" THEN
            RETURN FALSE.

        DO segmentIndex = 1 TO NUM-ENTRIES(pathValue, "/"):
            segment = ENTRY(segmentIndex, pathValue, "/").
            IF segment = "" OR segment = "." OR segment = ".." THEN RETURN FALSE.
            DO characterIndex = 1 TO LENGTH(segment):
                character = SUBSTRING(segment, characterIndex, 1).
                IF NOT ((character >= "A" AND character <= "Z")
                    OR (character >= "a" AND character <= "z")
                    OR (character >= "0" AND character <= "9")
                    OR character = "_" OR character = "-" OR character = ".") THEN
                    RETURN FALSE.
            END.
        END.

        IF LENGTH(pathValue) < 2 OR SUBSTRING(pathValue, LENGTH(pathValue) - 1, 2) <> ".p" THEN
            RETURN FALSE.
        RETURN TRUE.
    END METHOD.

    METHOD PRIVATE INTEGER SendJson(INPUT body AS JsonObject, INPUT statusCode AS INTEGER):
        DEFINE VARIABLE response AS IHttpResponse NO-UNDO.
        DEFINE VARIABLE writer AS WebResponseWriter NO-UNDO.

        ASSIGN
            response = NEW WebResponse()
            response:StatusCode = statusCode
            response:ContentType = "application/json":U
            response:Entity = body
            writer = NEW WebResponseWriter(response).
        writer:Open().
        writer:Close().
        RETURN 0.
    END METHOD.

    METHOD PRIVATE INTEGER SendError(INPUT code AS CHARACTER, INPUT requestId AS CHARACTER,
                                     INPUT statusCode AS INTEGER):
        RETURN SendError(code, requestId, statusCode, "").
    END METHOD.

    METHOD PRIVATE INTEGER SendError(INPUT code AS CHARACTER, INPUT requestId AS CHARACTER,
                                     INPUT statusCode AS INTEGER, INPUT detail AS CHARACTER):
        DEFINE VARIABLE body AS JsonObject NO-UNDO.

        body = NEW JsonObject().
        body:Add("ok", FALSE).
        body:Add("error", code).
        IF detail > "" THEN body:Add("detail", detail).
        body:Add("requestId", requestId).
        RETURN SendJson(body, statusCode).
    END METHOD.

    /* The workload's error code: the RETURN ERROR text, or the first message. Only tokens of
       at most 200 characters from [A-Za-z0-9_.:-] are returned, so no free-form ABL message,
       stack or data reaches the response. */
    METHOD PRIVATE CHARACTER WorkloadErrorDetail(INPUT poError AS Error):
        DEFINE VARIABLE detail AS CHARACTER NO-UNDO.
        DEFINE VARIABLE position AS INTEGER NO-UNDO.

        IF TYPE-OF(poError, Progress.Lang.AppError) THEN
            detail = CAST(poError, Progress.Lang.AppError):ReturnValue.
        IF (detail = ? OR detail = "") AND poError:NumMessages > 0 THEN
            detail = poError:GetMessage(1).
        IF detail = ? OR detail = "" OR LENGTH(detail) > 200 THEN RETURN "".
        DO position = 1 TO LENGTH(detail):
            IF INDEX("abcdefghijklmnopqrstuvwxyz0123456789_.:-",
                     LC(SUBSTRING(detail, position, 1))) = 0 THEN RETURN "".
        END.
        RETURN detail.
    END METHOD.
END CLASS.
