/* Freeze at most Limit distinct identities in native primary-ID order before
   changing any predicate/index fields. Locks join the handler transaction. */
ASSIGN pbResult = pbQuery:QUERY-OPEN() NO-ERROR.
IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN
  pbIgnored = pbFail("table_write_query:open").
DO pbRowNumber = 1 TO pbLimit:
  ASSIGN pbResult = pbQuery:GET-NEXT(EXCLUSIVE-LOCK, NO-WAIT) NO-ERROR.
  IF ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 OR pbTarget:LOCKED THEN
    pbIgnored = pbFail("table_write_conflict:selected_lock").
  IF pbQuery:QUERY-OFF-END THEN LEAVE.
  IF pbResult <> TRUE OR NOT pbTarget:AVAILABLE THEN
    pbIgnored = pbFail("table_write_conflict:selected_unavailable").
  CREATE pbSelected.
  ASSIGN pbSelected.ordinal = pbRowNumber pbSelected.recordRowid = pbTarget:ROWID
    pbSelected.primaryId = pbTarget:BUFFER-FIELD(pbPrimary):BUFFER-VALUE
    pbNewId = pbSelected.primaryId.
  &IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
  pbIgnored = pbWitness(pbPrimary, "selected").
  &ENDIF
END.
ASSIGN pbResult = pbQuery:QUERY-CLOSE() NO-ERROR.
IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN
  pbIgnored = pbFail("table_write_query:close").

/* Reacquire exactly the frozen identity, without reevaluating its predicate.
   No-match requests reach no allocation/assignment code. */
FOR EACH pbSelected BY pbSelected.ordinal:
  ASSIGN pbResult = pbTarget:FIND-BY-ROWID(pbSelected.recordRowid, EXCLUSIVE-LOCK, NO-WAIT) NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0
    OR NOT pbTarget:AVAILABLE OR pbTarget:LOCKED THEN
    pbIgnored = pbFail("table_write_conflict:frozen_unavailable").
  IF pbTarget:BUFFER-FIELD(pbPrimary):BUFFER-VALUE <> pbSelected.primaryId THEN
    pbIgnored = pbFail("table_write_conflict:frozen_identity").
  pbIgnored = pbGeneratorCleanup().
  EMPTY TEMP-TABLE pbPlan.
  ASSIGN pbNewId = pbSelected.primaryId pbToken = pbNewId
    pbCandidateOrdinal = 0 pbDomainChoice = "" pbNeedsToken = FALSE.
  FOR EACH pbField WHERE pbField.policyKind = "unique-text":
    IF LOOKUP(pbField.fieldName, pbFields) > 0 THEN pbNeedsToken = TRUE.
  END.
  IF pbNeedsToken THEN pbToken = DYNAMIC-NEXT-VALUE(pbSequence, "parkbench").
  pbIgnored = pbChooseDomain().
  pbIgnored = pbPrepareLobs().
  FOR EACH pbField BY pbField.ordinal:
    IF pbField.lobBytes > 0 OR LOOKUP(pbField.fieldName, pbFields) = 0 THEN NEXT.
    CREATE pbPlan.
    ASSIGN pbPlan.fieldName = pbField.fieldName pbPlan.dataType = pbField.dataType
      pbPlan.valueText = pbScalar(pbField.fieldName).
  END.
  IF pbTable = "AccountStatement" AND LOOKUP("PeriodStart", pbFields) > 0 THEN DO:
    FIND pbPlanned WHERE pbPlanned.fieldName = "PeriodStart".
    pbBusinessDate = pbDateValue(pbCurrentValue("PeriodEnd")).
    pbPlanned.valueText = pbDateString(DATE(MONTH(pbBusinessDate), 1, YEAR(pbBusinessDate))).
  END.
  REPEAT:
    pbConflict = pbUniqueConflict().
    IF pbConflict = "" THEN LEAVE.
    FIND pbUniqueIndex WHERE pbUniqueIndex.indexName = pbConflict.
    pbNeedsToken = FALSE.
    FOR EACH pbField WHERE pbField.policyKind = "unique-text":
      IF LOOKUP(pbField.fieldName, pbUniqueIndex.components) > 0 AND LOOKUP(pbField.fieldName, pbFields) > 0 THEN pbNeedsToken = TRUE.
    END.
    IF pbNeedsToken THEN DO:
      pbLastToken = pbToken.
      pbToken = DYNAMIC-NEXT-VALUE(pbSequence, "parkbench").
      IF pbToken <= pbLastToken THEN pbIgnored = pbFail("table_write_exhausted:sequence_range").
      FOR EACH pbField WHERE pbField.policyKind = "unique-text":
        IF LOOKUP(pbField.fieldName, pbFields) = 0 THEN NEXT.
        FIND pbPlanned WHERE pbPlanned.fieldName = pbField.fieldName.
        pbPlanned.valueText = pbScalar(pbField.fieldName).
      END.
    END.
    ELSE IF NOT pbAdvanceTuple(pbConflict) THEN pbIgnored = pbFail("table_write_exhausted:unique_tuple:" + pbConflict).
  END.
  FOR EACH pbPlan:
    pbAssignmentField = pbTarget:BUFFER-FIELD(pbPlan.fieldName).
    CASE pbPlan.dataType:
      WHEN "character" THEN pbAssignmentField:BUFFER-VALUE = pbPlan.valueText.
      WHEN "integer" THEN pbAssignmentField:BUFFER-VALUE = INTEGER(pbPlan.valueText).
      WHEN "int64" THEN pbAssignmentField:BUFFER-VALUE = INT64(pbPlan.valueText).
      WHEN "decimal" THEN pbAssignmentField:BUFFER-VALUE = DECIMAL(pbPlan.valueText).
      WHEN "logical" THEN pbAssignmentField:BUFFER-VALUE = pbLogicalValue(pbPlan.valueText).
      WHEN "date" THEN pbAssignmentField:BUFFER-VALUE = pbDateValue(pbPlan.valueText).
      WHEN "datetime" THEN pbAssignmentField:BUFFER-VALUE = DATETIME(pbPlan.valueText).
      WHEN "datetime-tz" THEN pbAssignmentField:BUFFER-VALUE = DATETIME-TZ(pbPlan.valueText).
      OTHERWISE pbIgnored = pbFail("table_write_assignment:unhandled_type").
    END CASE.
    &IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
    pbIgnored = pbWitness(pbPlan.fieldName, "ordinary").
    &ENDIF
  END.
  FOR EACH pbField WHERE pbField.lobBytes > 0:
    IF LOOKUP(pbField.fieldName, pbLobs) = 0 THEN NEXT.
    pbAssignmentField = pbTarget:BUFFER-FIELD(pbField.fieldName).
    IF pbField.dataType = "blob" THEN COPY-LOB FROM pbMemory TO pbAssignmentField:BUFFER-VALUE.
    ELSE COPY-LOB FROM pbText TO pbAssignmentField:BUFFER-VALUE.
    &IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
    pbIgnored = pbWitness(pbField.fieldName, "lob").
    &ENDIF
  END.
  ASSIGN pbResult = pbTarget:BUFFER-VALIDATE() NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN
    pbIgnored = pbFail("table_write_assignment:record_validation").
  ASSIGN pbResult = pbTarget:BUFFER-RELEASE() NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN
    pbIgnored = pbFail("table_write_assignment:record_release").
  SET-SIZE(pbMemory) = 0.
  pbText = "".
END.
