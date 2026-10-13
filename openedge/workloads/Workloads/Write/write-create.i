/* Main execution joins the request transaction; no database writes in
   predicate-callable helpers. Failed later rows roll back the whole request. */
/* An omitted mandatory LOB with unknown native initial state cannot validate.
   Detect that actual schema constraint before record creation, preserving a
   named diagnostic rather than relying on an implicit transaction-end error. */
FOR EACH pbField WHERE pbField.lobBytes > 0:
  IF LOOKUP(pbField.fieldName, pbLobs) > 0 THEN NEXT.
  pbAssignmentField = pbTarget:BUFFER-FIELD(pbField.fieldName).
  IF pbAssignmentField:MANDATORY AND pbAssignmentField:INITIAL = "" THEN
    pbIgnored = pbFail("table_write_assignment:mandatory_lob_omitted:" + pbField.fieldName).
END.
DO pbRowNumber = 1 TO pbLimit:
  pbIgnored = pbGeneratorCleanup().
  EMPTY TEMP-TABLE pbPlan.
  ASSIGN pbNewId = DYNAMIC-NEXT-VALUE(pbSequence, "parkbench")
    pbToken = pbNewId pbCandidateOrdinal = 0 pbDomainChoice = "".
  pbIgnored = pbChooseDomain().
  pbIgnored = pbPrepareLobs().
  FOR EACH pbField BY pbField.ordinal:
    IF pbField.lobBytes > 0 THEN NEXT.
    CREATE pbPlan.
    ASSIGN pbPlan.fieldName = pbField.fieldName pbPlan.dataType = pbField.dataType
      pbPlan.valueText = pbScalar(pbField.fieldName).
  END.
  IF pbTable = "AccountStatement" THEN DO:
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
      IF LOOKUP(pbField.fieldName, pbUniqueIndex.components) > 0 THEN pbNeedsToken = TRUE.
    END.
    IF pbNeedsToken THEN DO:
      pbLastToken = pbToken.
      pbToken = DYNAMIC-NEXT-VALUE(pbSequence, "parkbench").
      IF pbToken <= pbLastToken THEN pbIgnored = pbFail("table_write_exhausted:sequence_range").
      FOR EACH pbField WHERE pbField.policyKind = "unique-text":
        FIND pbPlanned WHERE pbPlanned.fieldName = pbField.fieldName.
        pbPlanned.valueText = pbScalar(pbField.fieldName).
      END.
    END.
    ELSE IF NOT pbAdvanceTuple(pbConflict) THEN pbIgnored = pbFail("table_write_exhausted:unique_tuple:" + pbConflict).
  END.
  ASSIGN pbResult = pbTarget:BUFFER-CREATE() NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN pbIgnored = pbFail("table_write_assignment:create").
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
  /* Native COPY-LOB validates other mandatory fields before initializing the
     first LOB. Initialize both in one atomic assignment only when selected. */
  IF pbTable = "StatementDocument" AND LOOKUP("PdfContent", pbLobs) > 0 AND LOOKUP("StatementXml", pbLobs) > 0 THEN DO:
    ASSIGN pbTarget:BUFFER-FIELD("PdfContent"):BUFFER-VALUE = pbMemory
      pbTarget:BUFFER-FIELD("StatementXml"):BUFFER-VALUE = pbText.
    &IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
    pbIgnored = pbWitness("PdfContent", "lob").
    pbIgnored = pbWitness("StatementXml", "lob").
    &ENDIF
  END.
  ELSE FOR EACH pbField WHERE pbField.lobBytes > 0:
    IF LOOKUP(pbField.fieldName, pbLobs) = 0 THEN NEXT.
    pbAssignmentField = pbTarget:BUFFER-FIELD(pbField.fieldName).
    IF pbField.dataType = "blob" THEN COPY-LOB FROM pbMemory TO pbAssignmentField:BUFFER-VALUE.
    ELSE COPY-LOB FROM pbText TO pbAssignmentField:BUFFER-VALUE.
    &IF DEFINED(PB-WRITE-WITNESS) <> 0 &THEN
    pbIgnored = pbWitness(pbField.fieldName, "lob").
    &ENDIF
  END.
  ASSIGN pbResult = pbTarget:BUFFER-VALIDATE() NO-ERROR.
  IF pbResult <> TRUE OR ERROR-STATUS:ERROR OR ERROR-STATUS:NUM-MESSAGES > 0 THEN pbIgnored = pbFail("table_write_assignment:record_validation").
  pbTarget:BUFFER-RELEASE().
  SET-SIZE(pbMemory) = 0.
  pbText = "".
END.
