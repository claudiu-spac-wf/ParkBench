/* Typed, explicit request-local planning. Database assignments stay in the
   execution fragments. All types are assigned explicitly; no ordinary create
   value is unknown. No unknown/default fallback is accepted. */
DEFINE TEMP-TABLE pbPlan NO-UNDO
  FIELD fieldName AS CHARACTER FIELD dataType AS CHARACTER FIELD valueText AS CHARACTER
  INDEX names IS UNIQUE fieldName.
DEFINE TEMP-TABLE pbParentState NO-UNDO
  FIELD fieldName AS CHARACTER FIELD hBuffer AS HANDLE FIELD hQuery AS HANDLE
  INDEX names IS UNIQUE fieldName.
DEFINE BUFFER pbPolicy FOR pbField.
DEFINE BUFFER pbPlanned FOR pbPlan.
DEFINE VARIABLE pbConflict AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbNeedsToken AS LOGICAL NO-UNDO.
DEFINE VARIABLE pbLastToken AS INT64 NO-UNDO.
DEFINE VARIABLE pbAssignmentField AS HANDLE NO-UNDO.
DEFINE VARIABLE pbBusinessDate AS DATE NO-UNDO.
DEFINE VARIABLE pbToken AS INT64 NO-UNDO.
DEFINE VARIABLE pbCandidateOrdinal AS INTEGER NO-UNDO.
DEFINE VARIABLE pbDomainChoice AS CHARACTER NO-UNDO.
DEFINE VARIABLE pbDigestMemory AS MEMPTR NO-UNDO.
DEFINE VARIABLE pbSecondText AS LONGCHAR NO-UNDO.

FUNCTION pbAttribute RETURNS CHARACTER (INPUT tupleValue AS CHARACTER, INPUT keyValue AS CHARACTER):
  DEFINE VARIABLE i AS INTEGER NO-UNDO.
  DEFINE VARIABLE itemValue AS CHARACTER NO-UNDO.
  DO i = 1 TO NUM-ENTRIES(tupleValue, "|"):
    itemValue = ENTRY(i, tupleValue, "|").
    IF ENTRY(1, itemValue, "=") = keyValue THEN RETURN SUBSTRING(itemValue, LENGTH(keyValue) + 2).
  END.
  pbIgnored = pbFail("table_write_policy:attribute:" + keyValue).
  RETURN "".
END FUNCTION.

FUNCTION pbDateValue RETURNS DATE (INPUT textValue AS CHARACTER):
  IF LENGTH(textValue) <> 10 OR SUBSTRING(textValue, 5, 1) <> "-" OR SUBSTRING(textValue, 8, 1) <> "-" THEN
    pbIgnored = pbFail("table_write_policy:date").
  RETURN DATE(INTEGER(SUBSTRING(textValue, 6, 2)), INTEGER(SUBSTRING(textValue, 9, 2)), INTEGER(SUBSTRING(textValue, 1, 4))).
END FUNCTION.

FUNCTION pbDateString RETURNS CHARACTER (INPUT dateValue AS DATE):
  RETURN STRING(YEAR(dateValue), "9999") + "-" + STRING(MONTH(dateValue), "99") + "-" + STRING(DAY(dateValue), "99").
END FUNCTION.

FUNCTION pbLogicalValue RETURNS LOGICAL (INPUT textValue AS CHARACTER):
  CASE textValue:
    WHEN "true" OR WHEN "yes" THEN RETURN TRUE.
    WHEN "false" OR WHEN "no" THEN RETURN FALSE.
    OTHERWISE pbIgnored = pbFail("table_write_policy:logical").
  END CASE.
  RETURN FALSE.
END FUNCTION.

FUNCTION pbEncodeKey RETURNS CHARACTER (INPUT token AS INT64, INPUT prefixValue AS CHARACTER, INPUT widthValue AS INTEGER, INPUT alphabet AS CHARACTER):
  DEFINE VARIABLE resultValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE remainderValue AS INTEGER NO-UNDO.
  IF token < 0 OR token = ? THEN pbIgnored = pbFail("table_write_exhausted:key_range").
  REPEAT:
    remainderValue = INTEGER(token MODULO LENGTH(alphabet)).
    resultValue = SUBSTRING(alphabet, remainderValue + 1, 1) + resultValue.
    token = TRUNCATE(token / LENGTH(alphabet), 0).
    IF token = 0 THEN LEAVE.
  END.
  IF LENGTH(resultValue) > widthValue - LENGTH(prefixValue) THEN pbIgnored = pbFail("table_write_exhausted:key_width").
  RETURN prefixValue + FILL("0", widthValue - LENGTH(prefixValue) - LENGTH(resultValue)) + resultValue.
END FUNCTION.

FUNCTION pbParentValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER, INPUT advanceValue AS LOGICAL) FORWARD.
FUNCTION pbAuditReference RETURNS CHARACTER () FORWARD.
FUNCTION pbCompanionValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER) FORWARD.
FUNCTION pbCurrentValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER) FORWARD.

FUNCTION pbScalar RETURNS CHARACTER (INPUT fieldValue AS CHARACTER):
  DEFINE VARIABLE dateValue AS DATE NO-UNDO.
  FIND pbPolicy WHERE pbPolicy.fieldName = fieldValue NO-ERROR.
  IF NOT AVAILABLE pbPolicy THEN pbIgnored = pbFail("table_write_policy:field:" + fieldValue).
  CASE pbPolicy.policyKind:
    WHEN "sequence" THEN RETURN STRING(pbNewId).
    WHEN "random" THEN RETURN STRING(RANDOM(1, INTEGER(pbPolicy.policyValue))).
    WHEN "literal" THEN DO:
      IF pbOperation = "update" AND pbTable = "CustomerContact" THEN DO:
        IF fieldValue = "ContactKind" AND LOOKUP("ContactValue", pbFields) = 0 THEN RETURN STRING(pbTarget:BUFFER-FIELD("ContactKind"):BUFFER-VALUE).
        IF fieldValue = "ContactValue" AND LOOKUP("ContactKind", pbFields) = 0 THEN DO:
          IF pbCurrentValue("ContactKind") = "EMAIL" THEN RETURN "customer@parkbench.invalid".
          RETURN "+40000000000".
        END.
      END.
      IF pbOperation = "update" AND pbTable = "AuditLog" AND fieldValue = "TableName" AND LOOKUP("RecordId", pbFields) = 0 THEN
        RETURN STRING(pbTarget:BUFFER-FIELD("TableName"):BUFFER-VALUE).
      RETURN pbPolicy.policyValue.
    END.
    WHEN "date" THEN RETURN pbPolicy.policyValue.
    WHEN "datetime" THEN RETURN STRING(DATETIME(TODAY, MTIME)).
    WHEN "datetime-tz" THEN RETURN STRING(NOW).
    WHEN "unique-text" THEN RETURN pbEncodeKey(pbToken, pbPolicy.policyValue, pbPolicy.fieldWidth,
      IF pbPolicy.policyChoices = "hex" THEN "0123456789ABCDEF" ELSE "0123456789").
    WHEN "unique-date" THEN DO:
      IF pbCandidateOrdinal > 36525 THEN pbIgnored = pbFail("table_write_exhausted:date_domain").
      dateValue = pbDateValue(pbPolicy.policyValue).
      IF pbPolicy.policyChoices = "month" OR pbPolicy.policyChoices = "month-end" THEN DO:
        dateValue = ADD-INTERVAL(dateValue, pbCandidateOrdinal, "months").
        IF pbPolicy.policyChoices = "month-end" THEN dateValue = ADD-INTERVAL(dateValue, 1, "months") - 1.
      END.
      ELSE dateValue = dateValue + pbCandidateOrdinal.
      RETURN pbDateString(dateValue).
    END.
    WHEN "wide-text" THEN RETURN SUBSTRING(FILL(pbPolicy.policyValue, INTEGER(pbPolicy.fieldWidth / LENGTH(pbPolicy.policyValue)) + 1), 1, INTEGER(pbPolicy.fieldWidth * 0.8)).
    WHEN "absent-parent" THEN RETURN pbPolicy.policyValue.
    WHEN "companion" THEN RETURN pbCompanionValue(fieldValue).
    WHEN "audit-reference" THEN RETURN pbAuditReference().
    WHEN "domain" THEN RETURN pbAttribute(pbDomainChoice, pbPolicy.fieldName).
    WHEN "parent" OR WHEN "parent-unique" THEN RETURN pbParentValue(fieldValue, FALSE).
    OTHERWISE pbIgnored = pbFail("table_write_policy:unhandled:" + pbTable + "." + fieldValue).
  END CASE.
  RETURN "".
END FUNCTION.

/* Indexed live-data checks. Never consult loaded maxima or create parents. */
FUNCTION pbHasRecord RETURNS LOGICAL (INPUT tableValue AS CHARACTER, INPUT fieldValue AS CHARACTER, INPUT keyValue AS CHARACTER, INPUT excluded AS ROWID):
  DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
  DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
  DEFINE VARIABLE conditionValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE foundValue AS LOGICAL NO-UNDO.
  DO ON ERROR UNDO, THROW:
    CREATE BUFFER hBuffer FOR TABLE tableValue.
    CREATE QUERY hQuery.
    IF hBuffer:BUFFER-FIELD(fieldValue):DATA-TYPE = "CHARACTER" THEN keyValue = QUOTER(keyValue).
    conditionValue = "FOR EACH " + tableValue + " WHERE " + fieldValue + " = " + keyValue.
    IF excluded <> ? THEN conditionValue = conditionValue + " AND ROWID(" + tableValue + ") <> TO-ROWID(" + QUOTER(STRING(excluded)) + ")".
    IF hQuery:SET-BUFFERS(hBuffer) <> TRUE OR hQuery:QUERY-PREPARE(conditionValue + " NO-LOCK") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN
      pbIgnored = pbFail("table_write_query:lookup").
    hQuery:GET-FIRST().
    foundValue = hBuffer:AVAILABLE.
    RETURN foundValue.
    FINALLY:
      IF VALID-HANDLE(hQuery) THEN DELETE OBJECT hQuery.
      IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
    END FINALLY.
  END.
END FUNCTION.

FUNCTION pbChooseDomain RETURNS LOGICAL ():
  DEFINE BUFFER domainCandidate FOR pbDomainRow.
  DEFINE VARIABLE keyName AS CHARACTER NO-UNDO.
  DEFINE VARIABLE keyValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE currentKey AS CHARACTER NO-UNDO.
  DEFINE VARIABLE excluded AS ROWID NO-UNDO.
  DEFINE VARIABLE codeValue AS INTEGER NO-UNDO.
  DEFINE VARIABLE minimumCode AS INTEGER NO-UNDO.
  DEFINE VARIABLE maximumCode AS INTEGER NO-UNDO.
  CASE pbTable:
    WHEN "Currency" THEN keyName = "CurrencyCode".
    WHEN "Country" THEN keyName = "CountryCode".
    WHEN "AccountType" THEN keyName = "AccountTypeCode".
    WHEN "TransactionType" THEN keyName = "TransactionTypeCode".
    WHEN "MerchantCategory" THEN keyName = "MccCode".
  END CASE.
  IF keyName = "" THEN RETURN TRUE.
  excluded = ?.
  IF pbOperation = "update" THEN DO:
    excluded = pbTarget:ROWID.
    /* Reassigning a constrained code is allowed. Keep existing live codes so
       target-only updates cannot invalidate inbound references in other tables. */
    currentKey = STRING(pbTarget:BUFFER-FIELD(keyName):BUFFER-VALUE).
  END.
  FOR EACH domainCandidate WHERE domainCandidate.tableName = pbTable BY domainCandidate.ordinal:
    IF pbTable = "MerchantCategory" THEN DO:
      minimumCode = INTEGER(pbAttribute(domainCandidate.attributes, "minimumCode")).
      maximumCode = INTEGER(pbAttribute(domainCandidate.attributes, "maximumCode")).
    END.
    ELSE ASSIGN minimumCode = 0 maximumCode = 0.
    DO codeValue = minimumCode TO maximumCode:
      keyValue = IF pbTable = "MerchantCategory" THEN STRING(codeValue, "9999") ELSE pbAttribute(domainCandidate.attributes, keyName).
      IF currentKey <> "" AND keyValue <> currentKey THEN NEXT.
      IF pbHasRecord(pbTable, keyName, keyValue, excluded) THEN NEXT.
      IF pbTable = "Country" AND NOT pbHasRecord("Currency", "CurrencyCode", pbAttribute(domainCandidate.attributes, "DefaultCurrencyCode"), ?) THEN NEXT.
      pbDomainChoice = domainCandidate.attributes.
      IF pbTable = "MerchantCategory" THEN pbDomainChoice = pbDomainChoice + "|MccCode=" + keyValue + "|Description=" + pbAttribute(pbDomainChoice, "CategoryGroup") + " merchant category".
      RETURN TRUE.
    END.
  END.
  pbIgnored = pbFail("table_write_exhausted:finite_domain:" + pbTable).
  RETURN FALSE.
END FUNCTION.


FUNCTION pbParentValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER, INPUT advanceValue AS LOGICAL):
  DEFINE BUFFER parentPolicy FOR pbField.
  DEFINE VARIABLE succeeded AS LOGICAL NO-UNDO.
  DEFINE VARIABLE valueText AS CHARACTER NO-UNDO.
  DEFINE VARIABLE conditionValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE otherField AS CHARACTER NO-UNDO.
  FIND parentPolicy WHERE parentPolicy.fieldName = fieldValue NO-ERROR.
  IF NOT AVAILABLE parentPolicy OR parentPolicy.parentTable = "" THEN pbIgnored = pbFail("table_write_policy:parent").
  IF parentPolicy.policyValue = "domain" THEN DO:
    valueText = pbAttribute(pbDomainChoice, fieldValue).
    IF NOT pbHasRecord(parentPolicy.parentTable, parentPolicy.parentField, valueText, ?) THEN pbIgnored = pbFail("table_write_missing_parent:" + fieldValue).
    RETURN valueText.
  END.
  FIND pbParentState WHERE pbParentState.fieldName = fieldValue NO-ERROR.
  IF NOT AVAILABLE pbParentState THEN DO:
    CREATE pbParentState.
    pbParentState.fieldName = fieldValue.
    CREATE BUFFER pbParentState.hBuffer FOR TABLE parentPolicy.parentTable.
    CREATE QUERY pbParentState.hQuery.
    conditionValue = "FOR EACH " + parentPolicy.parentTable.
    IF parentPolicy.parentTable = "TransactionType" AND (pbTable = "CreditTransaction" OR pbTable = "DebitTransaction") THEN
      conditionValue = conditionValue + " WHERE Direction = " + QUOTER(IF pbTable = "CreditTransaction" THEN "C" ELSE "D").
    IF pbTable = "ExchangeRate" AND parentPolicy.parentTable = "Currency" THEN DO:
      otherField = IF fieldValue = "FromCurrencyCode" THEN "ToCurrencyCode" ELSE "FromCurrencyCode".
      FIND pbPlanned WHERE pbPlanned.fieldName = otherField NO-ERROR.
      IF AVAILABLE pbPlanned OR pbOperation = "update" THEN
        conditionValue = conditionValue + " WHERE CurrencyCode <> " + QUOTER(pbCurrentValue(otherField)).
    END.
    IF pbParentState.hQuery:SET-BUFFERS(pbParentState.hBuffer) <> TRUE OR
      pbParentState.hQuery:QUERY-PREPARE(conditionValue + " NO-LOCK BY " + parentPolicy.parentTable + "." + parentPolicy.parentField) <> TRUE OR
      pbParentState.hQuery:QUERY-OPEN() <> TRUE THEN pbIgnored = pbFail("table_write_query:parent").
    succeeded = pbParentState.hQuery:GET-FIRST().
  END.
  ELSE IF advanceValue THEN succeeded = pbParentState.hQuery:GET-NEXT().
  ELSE succeeded = pbParentState.hBuffer:AVAILABLE.
  pbResult = TRUE.
  IF pbParentState.hQuery:QUERY-OFF-END AND advanceValue THEN DO:
    pbParentState.hQuery:QUERY-CLOSE().
    pbParentState.hQuery:QUERY-OPEN().
    succeeded = pbParentState.hQuery:GET-FIRST().
    pbResult = FALSE.
  END.
  IF succeeded <> TRUE OR NOT pbParentState.hBuffer:AVAILABLE THEN pbIgnored = pbFail("table_write_missing_parent:" + parentPolicy.parentTable).
  RETURN STRING(pbParentState.hBuffer:BUFFER-FIELD(parentPolicy.parentField):BUFFER-VALUE).
END FUNCTION.

FUNCTION pbGeneratorCleanup RETURNS LOGICAL ():
  FOR EACH pbParentState:
    IF VALID-HANDLE(pbParentState.hQuery) THEN DELETE OBJECT pbParentState.hQuery.
    IF VALID-HANDLE(pbParentState.hBuffer) THEN DELETE OBJECT pbParentState.hBuffer.
    DELETE pbParentState.
  END.
  SET-SIZE(pbDigestMemory) = 0.
  pbSecondText = "".
  RETURN TRUE.
END FUNCTION.


FUNCTION pbCurrentValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER):
  DEFINE BUFFER planValue FOR pbPlan.
  DEFINE VARIABLE hField AS HANDLE NO-UNDO.
  FIND planValue WHERE planValue.fieldName = fieldValue NO-ERROR.
  IF AVAILABLE planValue THEN RETURN planValue.valueText.
  IF NOT VALID-HANDLE(pbTarget) OR NOT pbTarget:AVAILABLE THEN pbIgnored = pbFail("table_write_policy:retained_field:" + fieldValue).
  hField = pbTarget:BUFFER-FIELD(fieldValue).
  IF hField:BUFFER-VALUE = ? THEN pbIgnored = pbFail("table_write_policy:unknown_retained:" + fieldValue).
  IF hField:DATA-TYPE = "DATE" THEN RETURN pbDateString(hField:BUFFER-VALUE).
  RETURN STRING(hField:BUFFER-VALUE).
END FUNCTION.

FUNCTION pbAuditReference RETURNS CHARACTER ():
  DEFINE VARIABLE tableValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
  DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
  DEFINE VARIABLE valueText AS CHARACTER NO-UNDO.
  DO ON ERROR UNDO, THROW:
    tableValue = "Account".
    IF pbOperation = "update" AND LOOKUP("TableName", pbFields) = 0 THEN tableValue = pbCurrentValue("TableName").
    FIND FIRST _File NO-LOCK WHERE _File._File-Name = tableValue AND _File._Tbl-Type = "T" NO-ERROR.
    IF NOT AVAILABLE _File THEN pbIgnored = pbFail("table_write_missing_parent:audit_target").
    CREATE BUFFER hBuffer FOR TABLE tableValue.
    CREATE QUERY hQuery.
    IF hQuery:SET-BUFFERS(hBuffer) <> TRUE OR hQuery:QUERY-PREPARE("FOR EACH " + tableValue + " NO-LOCK BY " + tableValue + "Id") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN pbIgnored = pbFail("table_write_query:audit_target").
    hQuery:GET-FIRST().
    IF NOT hBuffer:AVAILABLE THEN pbIgnored = pbFail("table_write_missing_parent:audit_record").
    valueText = STRING(hBuffer:BUFFER-FIELD(tableValue + "Id"):BUFFER-VALUE).
    RETURN valueText.
    FINALLY:
      IF VALID-HANDLE(hQuery) THEN DELETE OBJECT hQuery.
      IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
    END FINALLY.
  END.
END FUNCTION.

FUNCTION pbUniqueConflict RETURNS CHARACTER ():
  DEFINE BUFFER indexValue FOR pbUniqueIndex.
  DEFINE BUFFER fieldValue FOR pbField.
  DEFINE VARIABLE hBuffer AS HANDLE NO-UNDO.
  DEFINE VARIABLE hQuery AS HANDLE NO-UNDO.
  DEFINE VARIABLE conditionValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE component AS CHARACTER NO-UNDO.
  DEFINE VARIABLE textValue AS CHARACTER NO-UNDO.
  DEFINE VARIABLE dateValue AS DATE NO-UNDO.
  DEFINE VARIABLE i AS INTEGER NO-UNDO.
  DO ON ERROR UNDO, THROW:
    CREATE BUFFER hBuffer FOR TABLE pbTable.
    CREATE QUERY hQuery.
    hQuery:SET-BUFFERS(hBuffer).
    FOR EACH indexValue:
      conditionValue = "FOR EACH " + pbTable + " WHERE ".
      DO i = 1 TO NUM-ENTRIES(indexValue.components):
        component = ENTRY(i, indexValue.components).
        FIND fieldValue WHERE fieldValue.fieldName = component.
        textValue = pbCurrentValue(component).
        IF fieldValue.dataType = "character" THEN textValue = QUOTER(textValue).
        ELSE IF fieldValue.dataType = "date" THEN DO:
          dateValue = pbDateValue(textValue).
          textValue = "DATE(" + STRING(MONTH(dateValue)) + "," + STRING(DAY(dateValue)) + "," + STRING(YEAR(dateValue)) + ")".
        END.
        conditionValue = conditionValue + (IF i > 1 THEN " AND " ELSE "") + component + " = " + textValue.
      END.
      IF pbOperation = "update" THEN conditionValue = conditionValue + " AND ROWID(" + pbTable + ") <> TO-ROWID(" + QUOTER(STRING(pbTarget:ROWID)) + ")".
      IF hQuery:QUERY-PREPARE(conditionValue + " NO-LOCK") <> TRUE OR hQuery:QUERY-OPEN() <> TRUE THEN pbIgnored = pbFail("table_write_query:unique_tuple").
      hQuery:GET-FIRST().
      IF hBuffer:AVAILABLE THEN RETURN indexValue.indexName.
      hQuery:QUERY-CLOSE().
    END.
    RETURN "".
    FINALLY:
      IF VALID-HANDLE(hQuery) THEN DELETE OBJECT hQuery.
      IF VALID-HANDLE(hBuffer) THEN DELETE OBJECT hBuffer.
    END FINALLY.
  END.
END FUNCTION.

FUNCTION pbAdvanceTuple RETURNS LOGICAL (INPUT indexName AS CHARACTER):
  DEFINE BUFFER indexValue FOR pbUniqueIndex.
  DEFINE BUFFER fieldValue FOR pbField.
  DEFINE BUFFER planValue FOR pbPlan.
  DEFINE VARIABLE i AS INTEGER NO-UNDO.
  DEFINE VARIABLE component AS CHARACTER NO-UNDO.
  FIND indexValue WHERE indexValue.indexName = indexName.
  DO i = NUM-ENTRIES(indexValue.components) TO 1 BY -1:
    component = ENTRY(i, indexValue.components).
    IF pbOperation = "update" AND LOOKUP(component, pbFields) = 0 THEN NEXT.
    FIND fieldValue WHERE fieldValue.fieldName = component.
    FIND planValue WHERE planValue.fieldName = component.
    CASE fieldValue.policyKind:
      WHEN "parent" OR WHEN "parent-unique" THEN DO:
        planValue.valueText = pbParentValue(component, TRUE).
        IF pbResult THEN RETURN TRUE.
      END.
      WHEN "unique-date" THEN DO:
        pbCandidateOrdinal = pbCandidateOrdinal + 1.
        IF pbCandidateOrdinal > 36525 THEN pbCandidateOrdinal = 0.
        planValue.valueText = pbScalar(component).
        IF pbCandidateOrdinal > 0 THEN RETURN TRUE.
      END.
    END CASE.
  END.
  RETURN FALSE.
END FUNCTION.

/* Selected-only row staging. Binary defaults and ranges:
   Employee.Photo | BLOB | 24,576 | 8,192–49,152
   CustomerDocument.Content | BLOB | 16,384 | 4,096–65,536
   StatementDocument.PdfContent | BLOB | 8,192 | 3,072–32,768
   Text defaults and ranges:
   CustomerNote.NoteText | CLOB | 1,200 | 200–8,192
   StatementDocument.StatementXml | CLOB | 3,072 | 1,024–8,192
   AccountStatement.NoticeText | CLOB | 1,536 | 512–4,096
   CLOB sizes are UTF-8 bytes, not character counts. */
FUNCTION pbPrepareLobs RETURNS LOGICAL ():
  DEFINE BUFFER lobField FOR pbField.
  DEFINE VARIABLE i AS INTEGER NO-UNDO.
  DEFINE VARIABLE suffixValue AS CHARACTER NO-UNDO.
  SET-SIZE(pbMemory) = 0.
  SET-SIZE(pbDigestMemory) = 0.
  pbText = "".
  FOR EACH lobField WHERE lobField.lobBytes > 0:
    IF LOOKUP(lobField.fieldName, pbLobs) = 0 THEN NEXT.
    IF lobField.dataType = "blob" THEN DO:
      SET-SIZE(pbMemory) = lobField.lobBytes.
      DO i = 1 TO lobField.lobBytes:
        PUT-BYTE(pbMemory, i) = INTEGER((pbNewId + i) MODULO 251) + 1.
      END.
    END.
    ELSE IF lobField.dataType = "clob" THEN DO:
      FIX-CODEPAGE(pbText) = "UTF-8".
      suffixValue = "".
      IF lobField.fieldName = "StatementXml" THEN ASSIGN pbText = "<statement id='" + STRING(pbNewId) + "'>" suffixValue = "</statement>".
      DO WHILE LENGTH(pbText) < lobField.lobBytes - LENGTH(suffixValue):
        pbText = pbText + "Synthetic banking activity and customer service. ".
      END.
      pbText = SUBSTRING(pbText, 1, lobField.lobBytes - LENGTH(suffixValue)) + suffixValue.
      COPY-LOB FROM pbText TO pbDigestMemory CONVERT TARGET CODEPAGE "UTF-8".
      IF GET-SIZE(pbDigestMemory) <> lobField.lobBytes THEN pbIgnored = pbFail("table_write_policy:clob_bytes").
      SET-SIZE(pbDigestMemory) = 0.
    END.
    ELSE pbIgnored = pbFail("table_write_policy:lob_type").
  END.
  RETURN TRUE.
END FUNCTION.

/* FileSizeBytes and Checksum are ordinary fields: calculate them from planned
   content if both are selected, or from existing content if only the companion
   is selected. LOB-only writes never assign unselected companions. */
FUNCTION pbCompanionValue RETURNS CHARACTER (INPUT fieldValue AS CHARACTER):
  DEFINE BUFFER companionPolicy FOR pbField.
  DEFINE VARIABLE bytesValue AS INTEGER NO-UNDO.
  DEFINE VARIABLE digestValue AS CHARACTER NO-UNDO INITIAL "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".
  FIND companionPolicy WHERE companionPolicy.fieldName = fieldValue.
  IF LOOKUP(companionPolicy.policyValue, pbLobs) > 0 THEN DO:
    bytesValue = GET-SIZE(pbMemory).
    IF bytesValue > 0 THEN digestValue = HEX-ENCODE(MESSAGE-DIGEST("SHA-256", pbMemory)).
  END.
  ELSE IF pbOperation = "update" THEN DO:
    IF pbTarget:BUFFER-FIELD(companionPolicy.policyValue):BUFFER-VALUE <> ? THEN DO:
      COPY-LOB FROM pbTarget:BUFFER-FIELD(companionPolicy.policyValue):BUFFER-VALUE TO pbDigestMemory.
      bytesValue = GET-SIZE(pbDigestMemory).
      IF bytesValue > 0 THEN digestValue = HEX-ENCODE(MESSAGE-DIGEST("SHA-256", pbDigestMemory)).
      SET-SIZE(pbDigestMemory) = 0.
    END.
  END.
  RETURN IF fieldValue = "FileSizeBytes" THEN STRING(bytesValue) ELSE digestValue.
END FUNCTION.
