/* Native generator unit checks; does not invoke an operational workload. */
BLOCK-LEVEL ON ERROR UNDO, THROW.
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE SingleParam AS LONGCHAR NO-UNDO.
DEFINE VARIABLE config AS JsonObject NO-UNDO.
DEFINE VARIABLE result AS JsonObject NO-UNDO.
DEFINE VARIABLE rejected AS LOGICAL NO-UNDO.
DEFINE VARIABLE actual AS CHARACTER NO-UNDO.
DEFINE VARIABLE i AS INTEGER NO-UNDO.
&SCOPED-DEFINE PB-TABLE Currency
{write-common.i}
{write-generators.i}
{write-inventory.i}
pbIgnored = pbLoadInventory().
pbNewId = 11.
IF pbScalar("CurrencyId") <> "11" THEN UNDO, THROW NEW Progress.Lang.AppError("generator_sequence_failed",0).
DO i = 1 TO 100:
 actual = pbScalar("RandomInt10").
 IF INTEGER(actual) < 1 OR INTEGER(actual) > 10 THEN UNDO, THROW NEW Progress.Lang.AppError("generator_random_failed",0).
END.
IF NOT pbLogicalValue(pbScalar("IsActive")) THEN UNDO, THROW NEW Progress.Lang.AppError("generator_logical_failed",0).
IF DATETIME-TZ(pbScalar("CreatedAt")) = ? THEN UNDO, THROW NEW Progress.Lang.AppError("generator_timestamp_failed",0).
pbIgnored = pbAddField("TestDecimal", 100, "decimal", 0, 2, "", "", FALSE, 0, "literal", "1.25", "").
IF DECIMAL(pbScalar("TestDecimal")) <> 1.25 THEN UNDO, THROW NEW Progress.Lang.AppError("generator_decimal_failed",0).
pbIgnored = pbAddField("TestWide", 101, "character", 1200, 0, "", "", FALSE, 0, "wide-text", "Representative banking terms. ", "").
IF LENGTH(pbScalar("TestWide")) < 900 OR LENGTH(pbScalar("TestWide")) > 1200 THEN UNDO, THROW NEW Progress.Lang.AppError("generator_wide_failed",0).
IF pbEncodeKey(99999,"B",6,"0123456789") <> "B99999" THEN UNDO, THROW NEW Progress.Lang.AppError("generator_encoding_failed",0).
DO ON ERROR UNDO, THROW:
 actual = pbEncodeKey(100000,"B",6,"0123456789").
 CATCH failure AS Progress.Lang.Error:
  rejected = TRUE.
 END CATCH.
END.
IF NOT rejected THEN UNDO, THROW NEW Progress.Lang.AppError("generator_overflow_not_rejected",0).
pbOperation = "create".
pbIgnored = pbChooseDomain().
IF pbHasRecord("Currency","CurrencyCode",pbAttribute(pbDomainChoice,"CurrencyCode"),?) THEN UNDO, THROW NEW Progress.Lang.AppError("generator_used_domain_selected",0).
pbParser = NEW ObjectModelParser().
config = CAST(pbParser:Parse(SESSION:PARAMETER),JsonObject).
result = NEW JsonObject().
result:Add("ok",TRUE).
result:Add("domain",pbAttribute(pbDomainChoice,"CurrencyCode")).
result:WriteFile(config:GetCharacter("report"),TRUE).
QUIT.
