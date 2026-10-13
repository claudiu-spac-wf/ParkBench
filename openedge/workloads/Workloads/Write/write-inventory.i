/* Generated fixed-table metadata. */
FUNCTION pbLoadInventory RETURNS LOGICAL ():
  pbTable = "{&PB-TABLE}".
  CASE pbTable:
    WHEN "Currency" THEN DO:
      ASSIGN pbPrimary = "CurrencyId" pbSequence = "SeqCurrencyId".
      pbIgnored = pbAddField("CurrencyId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CurrencyCode", 6, "character", 3, 0, "", "", FALSE, 0, "domain", "Currency", "").
      pbIgnored = pbAddField("CurrencyName", 7, "character", 40, 0, "", "", FALSE, 0, "domain", "Currency", "").
      pbIgnored = pbAddField("NumericCode", 8, "integer", 0, 0, "", "", FALSE, 0, "domain", "Currency", "").
      pbIgnored = pbAddField("MinorUnits", 9, "integer", 0, 0, "", "", FALSE, 0, "domain", "Currency", "").
      pbIgnored = pbAddField("CurrencySymbol", 10, "character", 5, 0, "", "", FALSE, 0, "domain", "Currency", "").
      pbIgnored = pbAddField("IsActive", 11, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbRequirement("table", "Currency", "", "").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyId", "int64").
      pbIgnored = pbRequirement("field", "Currency", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Currency", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Currency", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Currency", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyCode", "character").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyName", "character").
      pbIgnored = pbRequirement("field", "Currency", "NumericCode", "integer").
      pbIgnored = pbRequirement("field", "Currency", "MinorUnits", "integer").
      pbIgnored = pbRequirement("field", "Currency", "CurrencySymbol", "character").
      pbIgnored = pbRequirement("field", "Currency", "IsActive", "logical").
      pbIgnored = pbRequirement("index", "Currency", "PkCurrency", "").
      pbIgnored = pbRequirement("index", "Currency", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Currency", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Currency", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Currency", "UxCurrencyCode", "").
      pbIgnored = pbUnique("UxCurrencyCode", "CurrencyCode").
    END.
    WHEN "Country" THEN DO:
      ASSIGN pbPrimary = "CountryId" pbSequence = "SeqCountryId".
      pbIgnored = pbAddField("CountryId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CountryCode", 6, "character", 2, 0, "", "", FALSE, 0, "domain", "Country", "").
      pbIgnored = pbAddField("CountryName", 7, "character", 60, 0, "", "", FALSE, 0, "domain", "Country", "").
      pbIgnored = pbAddField("DefaultCurrencyCode", 8, "character", 3, 0, "Currency", "CurrencyCode", FALSE, 0, "parent", "domain", "").
      pbIgnored = pbAddField("PhonePrefix", 9, "character", 6, 0, "", "", FALSE, 0, "domain", "Country", "").
      pbIgnored = pbRequirement("table", "Country", "", "").
      pbIgnored = pbRequirement("table", "Currency", "", "").
      pbIgnored = pbRequirement("field", "Country", "CountryId", "int64").
      pbIgnored = pbRequirement("field", "Country", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Country", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Country", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Country", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Country", "CountryCode", "character").
      pbIgnored = pbRequirement("field", "Country", "CountryName", "character").
      pbIgnored = pbRequirement("field", "Country", "DefaultCurrencyCode", "character").
      pbIgnored = pbRequirement("field", "Country", "PhonePrefix", "character").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyCode", "character").
      pbIgnored = pbRequirement("index", "Country", "PkCountry", "").
      pbIgnored = pbRequirement("index", "Country", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Country", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Country", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Country", "UxCountryCode", "").
      pbIgnored = pbRequirement("index", "Country", "IxDefaultCurrency", "").
      pbIgnored = pbRequirement("index", "Currency", "UxCurrencyCode", "").
      pbIgnored = pbUnique("UxCountryCode", "CountryCode").
    END.
    WHEN "ExchangeRate" THEN DO:
      ASSIGN pbPrimary = "ExchangeRateId" pbSequence = "SeqExchangeRateId".
      pbIgnored = pbAddField("ExchangeRateId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("RateDate", 6, "date", 0, 0, "", "", FALSE, 0, "unique-date", "2030-01-01", "day").
      pbIgnored = pbAddField("FromCurrencyCode", 7, "character", 3, 0, "Currency", "CurrencyCode", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("ToCurrencyCode", 8, "character", 3, 0, "Currency", "CurrencyCode", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("Rate", 9, "decimal", 0, 8, "", "", FALSE, 0, "literal", "1.125", "").
      pbIgnored = pbAddField("RateSource", 10, "character", 10, 0, "", "", FALSE, 0, "literal", "INTERNAL", "").
      pbIgnored = pbRequirement("table", "ExchangeRate", "", "").
      pbIgnored = pbRequirement("table", "Currency", "", "").
      pbIgnored = pbRequirement("field", "ExchangeRate", "ExchangeRateId", "int64").
      pbIgnored = pbRequirement("field", "ExchangeRate", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "ExchangeRate", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "ExchangeRate", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "ExchangeRate", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "ExchangeRate", "RateDate", "date").
      pbIgnored = pbRequirement("field", "ExchangeRate", "FromCurrencyCode", "character").
      pbIgnored = pbRequirement("field", "ExchangeRate", "ToCurrencyCode", "character").
      pbIgnored = pbRequirement("field", "ExchangeRate", "Rate", "decimal").
      pbIgnored = pbRequirement("field", "ExchangeRate", "RateSource", "character").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyCode", "character").
      pbIgnored = pbRequirement("index", "ExchangeRate", "PkExchangeRate", "").
      pbIgnored = pbRequirement("index", "ExchangeRate", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "ExchangeRate", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "ExchangeRate", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "ExchangeRate", "UxCurrencyPairDate", "").
      pbIgnored = pbRequirement("index", "Currency", "UxCurrencyCode", "").
      pbIgnored = pbUnique("UxCurrencyPairDate", "FromCurrencyCode,ToCurrencyCode,RateDate").
    END.
    WHEN "Branch" THEN DO:
      ASSIGN pbPrimary = "BranchId" pbSequence = "SeqBranchId".
      pbIgnored = pbAddField("BranchId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("BranchCode", 6, "character", 6, 0, "", "", FALSE, 0, "unique-text", "B", "decimal").
      pbIgnored = pbAddField("BranchName", 7, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench BranchName", "").
      pbIgnored = pbAddField("AddressLine1", 8, "character", 60, 0, "", "", FALSE, 0, "literal", "25 Park Avenue", "").
      pbIgnored = pbAddField("City", 9, "character", 40, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("StateProvince", 10, "character", 30, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("PostalCode", 11, "character", 10, 0, "", "", FALSE, 0, "literal", "010101", "").
      pbIgnored = pbAddField("CountryCode", 12, "character", 2, 0, "Country", "CountryCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("Phone", 13, "character", 20, 0, "", "", FALSE, 0, "literal", "+1-555-0100", "").
      pbIgnored = pbAddField("OpenDate", 14, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("IsActive", 15, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbRequirement("table", "Branch", "", "").
      pbIgnored = pbRequirement("table", "Country", "", "").
      pbIgnored = pbRequirement("field", "Branch", "BranchId", "int64").
      pbIgnored = pbRequirement("field", "Branch", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Branch", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Branch", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Branch", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Branch", "BranchCode", "character").
      pbIgnored = pbRequirement("field", "Branch", "BranchName", "character").
      pbIgnored = pbRequirement("field", "Branch", "AddressLine1", "character").
      pbIgnored = pbRequirement("field", "Branch", "City", "character").
      pbIgnored = pbRequirement("field", "Branch", "StateProvince", "character").
      pbIgnored = pbRequirement("field", "Branch", "PostalCode", "character").
      pbIgnored = pbRequirement("field", "Branch", "CountryCode", "character").
      pbIgnored = pbRequirement("field", "Branch", "Phone", "character").
      pbIgnored = pbRequirement("field", "Branch", "OpenDate", "date").
      pbIgnored = pbRequirement("field", "Branch", "IsActive", "logical").
      pbIgnored = pbRequirement("field", "Country", "CountryCode", "character").
      pbIgnored = pbRequirement("index", "Branch", "PkBranch", "").
      pbIgnored = pbRequirement("index", "Branch", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Branch", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Branch", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Branch", "UxBranchCode", "").
      pbIgnored = pbRequirement("index", "Branch", "IxCountryCity", "").
      pbIgnored = pbRequirement("index", "Country", "UxCountryCode", "").
      pbIgnored = pbUnique("UxBranchCode", "BranchCode").
    END.
    WHEN "Employee" THEN DO:
      ASSIGN pbPrimary = "EmployeeId" pbSequence = "SeqEmployeeId".
      pbIgnored = pbAddField("EmployeeId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("EmployeeNumber", 6, "character", 10, 0, "", "", FALSE, 0, "unique-text", "E", "decimal").
      pbIgnored = pbAddField("BranchId", 7, "int64", 0, 0, "Branch", "BranchId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("FirstName", 8, "character", 30, 0, "", "", FALSE, 0, "literal", "Alex", "").
      pbIgnored = pbAddField("LastName", 9, "character", 40, 0, "", "", FALSE, 0, "literal", "Taylor", "").
      pbIgnored = pbAddField("JobTitle", 10, "character", 40, 0, "", "", FALSE, 0, "literal", "Banker", "").
      pbIgnored = pbAddField("Email", 11, "character", 80, 0, "", "", FALSE, 0, "literal", "alex.taylor@example.test", "").
      pbIgnored = pbAddField("HireDate", 12, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("TerminationDate", 13, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("IsBranchManager", 14, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("Salary", 15, "decimal", 0, 2, "", "", FALSE, 0, "literal", "65000", "").
      pbIgnored = pbAddField("Photo", 16, "blob", 0, 0, "", "", FALSE, 24576, "lob", "24576", "").
      pbIgnored = pbAddField("UpdatedAt", 17, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("table", "Branch", "", "").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("field", "Employee", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Employee", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Employee", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Employee", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeNumber", "character").
      pbIgnored = pbRequirement("field", "Employee", "BranchId", "int64").
      pbIgnored = pbRequirement("field", "Employee", "FirstName", "character").
      pbIgnored = pbRequirement("field", "Employee", "LastName", "character").
      pbIgnored = pbRequirement("field", "Employee", "JobTitle", "character").
      pbIgnored = pbRequirement("field", "Employee", "Email", "character").
      pbIgnored = pbRequirement("field", "Employee", "HireDate", "date").
      pbIgnored = pbRequirement("field", "Employee", "TerminationDate", "date").
      pbIgnored = pbRequirement("field", "Employee", "IsBranchManager", "logical").
      pbIgnored = pbRequirement("field", "Employee", "Salary", "decimal").
      pbIgnored = pbRequirement("field", "Employee", "Photo", "blob").
      pbIgnored = pbRequirement("field", "Employee", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Branch", "BranchId", "int64").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
      pbIgnored = pbRequirement("index", "Employee", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Employee", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Employee", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Employee", "UxEmployeeNumber", "").
      pbIgnored = pbRequirement("index", "Employee", "IxBranch", "").
      pbIgnored = pbRequirement("index", "Employee", "IxName", "").
      pbIgnored = pbRequirement("index", "Branch", "PkBranch", "").
      pbIgnored = pbUnique("UxEmployeeNumber", "EmployeeNumber").
    END.
    WHEN "AccountType" THEN DO:
      ASSIGN pbPrimary = "AccountTypeId" pbSequence = "SeqAccountTypeId".
      pbIgnored = pbAddField("AccountTypeId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountTypeCode", 6, "character", 10, 0, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("AccountTypeName", 7, "character", 50, 0, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("Category", 8, "character", 12, 0, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("Description", 9, "character", 200, 0, "", "", FALSE, 0, "literal", "Representative banking account", "").
      pbIgnored = pbAddField("TermsText", 10, "character", 1200, 0, "", "", FALSE, 0, "wide-text", "Banking terms and account conditions. ", "").
      pbIgnored = pbAddField("MinimumBalance", 11, "decimal", 0, 2, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("MonthlyFee", 12, "decimal", 0, 2, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("OverdraftAllowed", 13, "logical", 0, 0, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("TermMonths", 14, "integer", 0, 0, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("CurrentInterestRate", 15, "decimal", 0, 4, "", "", FALSE, 0, "domain", "AccountType", "").
      pbIgnored = pbAddField("IsActive", 16, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbRequirement("table", "AccountType", "", "").
      pbIgnored = pbRequirement("field", "AccountType", "AccountTypeId", "int64").
      pbIgnored = pbRequirement("field", "AccountType", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "AccountType", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "AccountType", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "AccountType", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AccountType", "AccountTypeCode", "character").
      pbIgnored = pbRequirement("field", "AccountType", "AccountTypeName", "character").
      pbIgnored = pbRequirement("field", "AccountType", "Category", "character").
      pbIgnored = pbRequirement("field", "AccountType", "Description", "character").
      pbIgnored = pbRequirement("field", "AccountType", "TermsText", "character").
      pbIgnored = pbRequirement("field", "AccountType", "MinimumBalance", "decimal").
      pbIgnored = pbRequirement("field", "AccountType", "MonthlyFee", "decimal").
      pbIgnored = pbRequirement("field", "AccountType", "OverdraftAllowed", "logical").
      pbIgnored = pbRequirement("field", "AccountType", "TermMonths", "integer").
      pbIgnored = pbRequirement("field", "AccountType", "CurrentInterestRate", "decimal").
      pbIgnored = pbRequirement("field", "AccountType", "IsActive", "logical").
      pbIgnored = pbRequirement("index", "AccountType", "PkAccountType", "").
      pbIgnored = pbRequirement("index", "AccountType", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "AccountType", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "AccountType", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "AccountType", "UxAccountTypeCode", "").
      pbIgnored = pbRequirement("index", "AccountType", "IxCategory", "").
      pbIgnored = pbUnique("UxAccountTypeCode", "AccountTypeCode").
    END.
    WHEN "InterestRateHistory" THEN DO:
      ASSIGN pbPrimary = "InterestRateHistoryId" pbSequence = "SeqInterestRateHistoryId".
      pbIgnored = pbAddField("InterestRateHistoryId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountTypeId", 6, "int64", 0, 0, "AccountType", "AccountTypeId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("EffectiveDate", 7, "date", 0, 0, "", "", FALSE, 0, "unique-date", "2030-01-01", "month").
      pbIgnored = pbAddField("InterestRate", 8, "decimal", 0, 4, "", "", FALSE, 0, "literal", "2.5", "").
      pbIgnored = pbAddField("ChangedByEmployeeId", 9, "int64", 0, 0, "Employee", "EmployeeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbRequirement("table", "InterestRateHistory", "", "").
      pbIgnored = pbRequirement("table", "AccountType", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "InterestRateHistoryId", "int64").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "AccountTypeId", "int64").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "EffectiveDate", "date").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "InterestRate", "decimal").
      pbIgnored = pbRequirement("field", "InterestRateHistory", "ChangedByEmployeeId", "int64").
      pbIgnored = pbRequirement("field", "AccountType", "AccountTypeId", "int64").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("index", "InterestRateHistory", "PkInterestRateHistory", "").
      pbIgnored = pbRequirement("index", "InterestRateHistory", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "InterestRateHistory", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "InterestRateHistory", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "InterestRateHistory", "UxTypeEffective", "").
      pbIgnored = pbRequirement("index", "AccountType", "PkAccountType", "").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
      pbIgnored = pbUnique("UxTypeEffective", "AccountTypeId,EffectiveDate").
    END.
    WHEN "TransactionType" THEN DO:
      ASSIGN pbPrimary = "TransactionTypeId" pbSequence = "SeqTransactionTypeId".
      pbIgnored = pbAddField("TransactionTypeId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("TransactionTypeCode", 6, "character", 8, 0, "", "", FALSE, 0, "domain", "TransactionType", "").
      pbIgnored = pbAddField("Description", 7, "character", 60, 0, "", "", FALSE, 0, "domain", "TransactionType", "").
      pbIgnored = pbAddField("Direction", 8, "character", 1, 0, "", "", FALSE, 0, "domain", "TransactionType", "").
      pbIgnored = pbAddField("Channel", 9, "character", 10, 0, "", "", FALSE, 0, "domain", "TransactionType", "").
      pbIgnored = pbAddField("IsFee", 10, "logical", 0, 0, "", "", FALSE, 0, "domain", "TransactionType", "").
      pbIgnored = pbRequirement("table", "TransactionType", "", "").
      pbIgnored = pbRequirement("field", "TransactionType", "TransactionTypeId", "int64").
      pbIgnored = pbRequirement("field", "TransactionType", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "TransactionType", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "TransactionType", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "TransactionType", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "TransactionType", "TransactionTypeCode", "character").
      pbIgnored = pbRequirement("field", "TransactionType", "Description", "character").
      pbIgnored = pbRequirement("field", "TransactionType", "Direction", "character").
      pbIgnored = pbRequirement("field", "TransactionType", "Channel", "character").
      pbIgnored = pbRequirement("field", "TransactionType", "IsFee", "logical").
      pbIgnored = pbRequirement("index", "TransactionType", "PkTransactionType", "").
      pbIgnored = pbRequirement("index", "TransactionType", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "TransactionType", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "TransactionType", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "TransactionType", "UxTransactionTypeCode", "").
      pbIgnored = pbRequirement("index", "TransactionType", "IxDirectionChannel", "").
      pbIgnored = pbUnique("UxTransactionTypeCode", "TransactionTypeCode").
    END.
    WHEN "MerchantCategory" THEN DO:
      ASSIGN pbPrimary = "MerchantCategoryId" pbSequence = "SeqMerchantCategoryId".
      pbIgnored = pbAddField("MerchantCategoryId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("MccCode", 6, "character", 4, 0, "", "", FALSE, 0, "domain", "MerchantCategory", "").
      pbIgnored = pbAddField("Description", 7, "character", 80, 0, "", "", FALSE, 0, "domain", "MerchantCategory", "").
      pbIgnored = pbAddField("CategoryGroup", 8, "character", 30, 0, "", "", FALSE, 0, "domain", "MerchantCategory", "").
      pbIgnored = pbRequirement("table", "MerchantCategory", "", "").
      pbIgnored = pbRequirement("field", "MerchantCategory", "MerchantCategoryId", "int64").
      pbIgnored = pbRequirement("field", "MerchantCategory", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "MerchantCategory", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "MerchantCategory", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "MerchantCategory", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "MerchantCategory", "MccCode", "character").
      pbIgnored = pbRequirement("field", "MerchantCategory", "Description", "character").
      pbIgnored = pbRequirement("field", "MerchantCategory", "CategoryGroup", "character").
      pbIgnored = pbRequirement("index", "MerchantCategory", "PkMerchantCategory", "").
      pbIgnored = pbRequirement("index", "MerchantCategory", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "MerchantCategory", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "MerchantCategory", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "MerchantCategory", "UxMccCode", "").
      pbIgnored = pbUnique("UxMccCode", "MccCode").
    END.
    WHEN "Merchant" THEN DO:
      ASSIGN pbPrimary = "MerchantId" pbSequence = "SeqMerchantId".
      pbIgnored = pbAddField("MerchantId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("MerchantNumber", 6, "character", 15, 0, "", "", FALSE, 0, "unique-text", "M", "decimal").
      pbIgnored = pbAddField("MerchantName", 7, "character", 80, 0, "", "", FALSE, 0, "literal", "ParkBench MerchantName", "").
      pbIgnored = pbAddField("MerchantCategoryId", 8, "int64", 0, 0, "MerchantCategory", "MerchantCategoryId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("City", 9, "character", 40, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("StateProvince", 10, "character", 30, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("PostalCode", 11, "character", 10, 0, "", "", FALSE, 0, "literal", "010101", "").
      pbIgnored = pbAddField("CountryCode", 12, "character", 2, 0, "Country", "CountryCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("Latitude", 13, "decimal", 0, 6, "", "", FALSE, 0, "literal", "44.4268", "").
      pbIgnored = pbAddField("Longitude", 14, "decimal", 0, 6, "", "", FALSE, 0, "literal", "26.1025", "").
      pbIgnored = pbAddField("IsOnline", 15, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("RiskScore", 16, "integer", 0, 0, "", "", FALSE, 0, "literal", "20", "").
      pbIgnored = pbAddField("UpdatedAt", 17, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Merchant", "", "").
      pbIgnored = pbRequirement("table", "Country", "", "").
      pbIgnored = pbRequirement("table", "MerchantCategory", "", "").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantId", "int64").
      pbIgnored = pbRequirement("field", "Merchant", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Merchant", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Merchant", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Merchant", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantNumber", "character").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantName", "character").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantCategoryId", "int64").
      pbIgnored = pbRequirement("field", "Merchant", "City", "character").
      pbIgnored = pbRequirement("field", "Merchant", "StateProvince", "character").
      pbIgnored = pbRequirement("field", "Merchant", "PostalCode", "character").
      pbIgnored = pbRequirement("field", "Merchant", "CountryCode", "character").
      pbIgnored = pbRequirement("field", "Merchant", "Latitude", "decimal").
      pbIgnored = pbRequirement("field", "Merchant", "Longitude", "decimal").
      pbIgnored = pbRequirement("field", "Merchant", "IsOnline", "logical").
      pbIgnored = pbRequirement("field", "Merchant", "RiskScore", "integer").
      pbIgnored = pbRequirement("field", "Merchant", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "MerchantCategory", "MerchantCategoryId", "int64").
      pbIgnored = pbRequirement("field", "Country", "CountryCode", "character").
      pbIgnored = pbRequirement("index", "Merchant", "PkMerchant", "").
      pbIgnored = pbRequirement("index", "Merchant", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Merchant", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Merchant", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Merchant", "UxMerchantNumber", "").
      pbIgnored = pbRequirement("index", "Merchant", "IxCategory", "").
      pbIgnored = pbRequirement("index", "Merchant", "IxCountryCity", "").
      pbIgnored = pbRequirement("index", "Merchant", "WxMerchantName", "").
      pbIgnored = pbRequirement("index", "MerchantCategory", "PkMerchantCategory", "").
      pbIgnored = pbRequirement("index", "Country", "UxCountryCode", "").
      pbIgnored = pbUnique("UxMerchantNumber", "MerchantNumber").
    END.
    WHEN "Customer" THEN DO:
      ASSIGN pbPrimary = "CustomerId" pbSequence = "SeqCustomerId".
      pbIgnored = pbAddField("CustomerId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerNumber", 6, "character", 12, 0, "", "", FALSE, 0, "unique-text", "C", "decimal").
      pbIgnored = pbAddField("CustomerKind", 7, "character", 1, 0, "", "", FALSE, 0, "literal", "I", "").
      pbIgnored = pbAddField("FirstName", 8, "character", 30, 0, "", "", FALSE, 0, "literal", "Alex", "").
      pbIgnored = pbAddField("MiddleName", 9, "character", 30, 0, "", "", FALSE, 0, "literal", "Morgan", "").
      pbIgnored = pbAddField("LastName", 10, "character", 40, 0, "", "", FALSE, 0, "literal", "Taylor", "").
      pbIgnored = pbAddField("BusinessName", 11, "character", 80, 0, "", "", FALSE, 0, "literal", "ParkBench BusinessName", "").
      pbIgnored = pbAddField("DateOfBirth", 12, "date", 0, 0, "", "", FALSE, 0, "date", "1985-06-15", "").
      pbIgnored = pbAddField("TaxIdMasked", 13, "character", 11, 0, "", "", FALSE, 0, "literal", "***-**-1234", "").
      pbIgnored = pbAddField("Email", 14, "character", 80, 0, "", "", FALSE, 0, "literal", "alex.taylor@example.test", "").
      pbIgnored = pbAddField("PreferredLanguage", 15, "character", 5, 0, "", "", FALSE, 0, "literal", "en", "").
      pbIgnored = pbAddField("HomeBranchId", 16, "int64", 0, 0, "Branch", "BranchId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("Segment", 17, "character", 10, 0, "", "", FALSE, 0, "literal", "RETAIL", "").
      pbIgnored = pbAddField("CreditScore", 18, "integer", 0, 0, "", "", FALSE, 0, "literal", "700", "").
      pbIgnored = pbAddField("AnnualIncome", 19, "decimal", 0, 2, "", "", FALSE, 0, "literal", "85000", "").
      pbIgnored = pbAddField("CustomerSince", 20, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("CustomerStatus", 21, "character", 10, 0, "", "", FALSE, 0, "literal", "ACTIVE", "").
      pbIgnored = pbAddField("IsPaperless", 22, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("MarketingOptIn", 23, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("KycVerifiedAt", 24, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("RiskRating", 25, "character", 1, 0, "", "", FALSE, 0, "literal", "L", "").
      pbIgnored = pbAddField("Occupation", 26, "character", 40, 0, "", "", FALSE, 0, "literal", "Engineer", "").
      pbIgnored = pbAddField("EmployerName", 27, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench Systems", "").
      pbIgnored = pbAddField("SecurityQuestion", 28, "character", 100, 0, "", "", FALSE, 0, "literal", "What was your first school?", "").
      pbIgnored = pbAddField("Preferences", 29, "character", 300, 0, "", "", FALSE, 0, "wide-text", "language=en;alerts=yes;channel=online;", "").
      pbIgnored = pbAddField("LastContactDate", 30, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("UpdatedAt", 31, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("table", "Branch", "", "").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Customer", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Customer", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Customer", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Customer", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerNumber", "character").
      pbIgnored = pbRequirement("field", "Customer", "CustomerKind", "character").
      pbIgnored = pbRequirement("field", "Customer", "FirstName", "character").
      pbIgnored = pbRequirement("field", "Customer", "MiddleName", "character").
      pbIgnored = pbRequirement("field", "Customer", "LastName", "character").
      pbIgnored = pbRequirement("field", "Customer", "BusinessName", "character").
      pbIgnored = pbRequirement("field", "Customer", "DateOfBirth", "date").
      pbIgnored = pbRequirement("field", "Customer", "TaxIdMasked", "character").
      pbIgnored = pbRequirement("field", "Customer", "Email", "character").
      pbIgnored = pbRequirement("field", "Customer", "PreferredLanguage", "character").
      pbIgnored = pbRequirement("field", "Customer", "HomeBranchId", "int64").
      pbIgnored = pbRequirement("field", "Customer", "Segment", "character").
      pbIgnored = pbRequirement("field", "Customer", "CreditScore", "integer").
      pbIgnored = pbRequirement("field", "Customer", "AnnualIncome", "decimal").
      pbIgnored = pbRequirement("field", "Customer", "CustomerSince", "date").
      pbIgnored = pbRequirement("field", "Customer", "CustomerStatus", "character").
      pbIgnored = pbRequirement("field", "Customer", "IsPaperless", "logical").
      pbIgnored = pbRequirement("field", "Customer", "MarketingOptIn", "logical").
      pbIgnored = pbRequirement("field", "Customer", "KycVerifiedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "RiskRating", "character").
      pbIgnored = pbRequirement("field", "Customer", "Occupation", "character").
      pbIgnored = pbRequirement("field", "Customer", "EmployerName", "character").
      pbIgnored = pbRequirement("field", "Customer", "SecurityQuestion", "character").
      pbIgnored = pbRequirement("field", "Customer", "Preferences", "character").
      pbIgnored = pbRequirement("field", "Customer", "LastContactDate", "date").
      pbIgnored = pbRequirement("field", "Customer", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Branch", "BranchId", "int64").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbRequirement("index", "Customer", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Customer", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Customer", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Customer", "UxCustomerNumber", "").
      pbIgnored = pbRequirement("index", "Customer", "IxName", "").
      pbIgnored = pbRequirement("index", "Customer", "IxHomeBranch", "").
      pbIgnored = pbRequirement("index", "Customer", "IxStatusSegment", "").
      pbIgnored = pbRequirement("index", "Customer", "IxEmail", "").
      pbIgnored = pbRequirement("index", "Branch", "PkBranch", "").
      pbIgnored = pbUnique("UxCustomerNumber", "CustomerNumber").
    END.
    WHEN "CustomerAddress" THEN DO:
      ASSIGN pbPrimary = "CustomerAddressId" pbSequence = "SeqCustomerAddressId".
      pbIgnored = pbAddField("CustomerAddressId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AddressKind", 7, "character", 8, 0, "", "", FALSE, 0, "literal", "HOME", "").
      pbIgnored = pbAddField("AddressLine1", 8, "character", 60, 0, "", "", FALSE, 0, "literal", "25 Park Avenue", "").
      pbIgnored = pbAddField("AddressLine2", 9, "character", 60, 0, "", "", FALSE, 0, "literal", "Suite 12", "").
      pbIgnored = pbAddField("City", 10, "character", 40, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("StateProvince", 11, "character", 30, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("PostalCode", 12, "character", 10, 0, "", "", FALSE, 0, "literal", "010101", "").
      pbIgnored = pbAddField("CountryCode", 13, "character", 2, 0, "Country", "CountryCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("IsPrimary", 14, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("ValidFrom", 15, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("ValidTo", 16, "date", 0, 0, "", "", FALSE, 0, "date", "2029-10-01", "").
      pbIgnored = pbAddField("UpdatedAt", 17, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "CustomerAddress", "", "").
      pbIgnored = pbRequirement("table", "Country", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "CustomerAddress", "CustomerAddressId", "int64").
      pbIgnored = pbRequirement("field", "CustomerAddress", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CustomerAddress", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CustomerAddress", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CustomerAddress", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerAddress", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "CustomerAddress", "AddressKind", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "AddressLine1", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "AddressLine2", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "City", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "StateProvince", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "PostalCode", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "CountryCode", "character").
      pbIgnored = pbRequirement("field", "CustomerAddress", "IsPrimary", "logical").
      pbIgnored = pbRequirement("field", "CustomerAddress", "ValidFrom", "date").
      pbIgnored = pbRequirement("field", "CustomerAddress", "ValidTo", "date").
      pbIgnored = pbRequirement("field", "CustomerAddress", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Country", "CountryCode", "character").
      pbIgnored = pbRequirement("index", "CustomerAddress", "PkCustomerAddress", "").
      pbIgnored = pbRequirement("index", "CustomerAddress", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CustomerAddress", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CustomerAddress", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CustomerAddress", "IxCustomer", "").
      pbIgnored = pbRequirement("index", "CustomerAddress", "IxCountryPostal", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbRequirement("index", "Country", "UxCountryCode", "").
    END.
    WHEN "CustomerContact" THEN DO:
      ASSIGN pbPrimary = "CustomerContactId" pbSequence = "SeqCustomerContactId".
      pbIgnored = pbAddField("CustomerContactId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("ContactKind", 7, "character", 8, 0, "", "", FALSE, 0, "literal", "EMAIL", "").
      pbIgnored = pbAddField("ContactValue", 8, "character", 80, 0, "", "", FALSE, 0, "literal", "alex.taylor@example.test", "").
      pbIgnored = pbAddField("IsPrimary", 9, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("IsVerified", 10, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("VerifiedAt", 11, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("UpdatedAt", 12, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "CustomerContact", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "CustomerContact", "CustomerContactId", "int64").
      pbIgnored = pbRequirement("field", "CustomerContact", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CustomerContact", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CustomerContact", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CustomerContact", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerContact", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "CustomerContact", "ContactKind", "character").
      pbIgnored = pbRequirement("field", "CustomerContact", "ContactValue", "character").
      pbIgnored = pbRequirement("field", "CustomerContact", "IsPrimary", "logical").
      pbIgnored = pbRequirement("field", "CustomerContact", "IsVerified", "logical").
      pbIgnored = pbRequirement("field", "CustomerContact", "VerifiedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerContact", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("index", "CustomerContact", "PkCustomerContact", "").
      pbIgnored = pbRequirement("index", "CustomerContact", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CustomerContact", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CustomerContact", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CustomerContact", "IxCustomer", "").
      pbIgnored = pbRequirement("index", "CustomerContact", "IxContactValue", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
    END.
    WHEN "CustomerDocument" THEN DO:
      ASSIGN pbPrimary = "CustomerDocumentId" pbSequence = "SeqCustomerDocumentId".
      pbIgnored = pbAddField("CustomerDocumentId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("DocumentKind", 7, "character", 12, 0, "", "", FALSE, 0, "literal", "PASSPORT", "").
      pbIgnored = pbAddField("DocumentNumberMasked", 8, "character", 20, 0, "", "", FALSE, 0, "literal", "*****1234", "").
      pbIgnored = pbAddField("IssuingCountryCode", 9, "character", 2, 0, "Country", "CountryCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("IssueDate", 10, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("ExpiryDate", 11, "date", 0, 0, "", "", FALSE, 0, "date", "2029-10-01", "").
      pbIgnored = pbAddField("VerificationStatus", 12, "character", 10, 0, "", "", FALSE, 0, "literal", "VERIFIED", "").
      pbIgnored = pbAddField("VerifiedByEmployeeId", 13, "int64", 0, 0, "Employee", "EmployeeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("MimeType", 14, "character", 40, 0, "", "", FALSE, 0, "literal", "application/pdf", "").
      pbIgnored = pbAddField("FileName", 15, "character", 80, 0, "", "", FALSE, 0, "literal", "document.pdf", "").
      pbIgnored = pbAddField("FileSizeBytes", 16, "int64", 0, 0, "", "", FALSE, 0, "companion", "Content", "").
      pbIgnored = pbAddField("Content", 17, "blob", 0, 0, "", "", FALSE, 16384, "lob", "16384", "").
      pbIgnored = pbAddField("UpdatedAt", 18, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "CustomerDocument", "", "").
      pbIgnored = pbRequirement("table", "Country", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("field", "CustomerDocument", "CustomerDocumentId", "int64").
      pbIgnored = pbRequirement("field", "CustomerDocument", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CustomerDocument", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CustomerDocument", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CustomerDocument", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerDocument", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "CustomerDocument", "DocumentKind", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "DocumentNumberMasked", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "IssuingCountryCode", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "IssueDate", "date").
      pbIgnored = pbRequirement("field", "CustomerDocument", "ExpiryDate", "date").
      pbIgnored = pbRequirement("field", "CustomerDocument", "VerificationStatus", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "VerifiedByEmployeeId", "int64").
      pbIgnored = pbRequirement("field", "CustomerDocument", "MimeType", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "FileName", "character").
      pbIgnored = pbRequirement("field", "CustomerDocument", "FileSizeBytes", "int64").
      pbIgnored = pbRequirement("field", "CustomerDocument", "Content", "blob").
      pbIgnored = pbRequirement("field", "CustomerDocument", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Country", "CountryCode", "character").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("index", "CustomerDocument", "PkCustomerDocument", "").
      pbIgnored = pbRequirement("index", "CustomerDocument", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CustomerDocument", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CustomerDocument", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CustomerDocument", "IxCustomer", "").
      pbIgnored = pbRequirement("index", "CustomerDocument", "IxExpiry", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbRequirement("index", "Country", "UxCountryCode", "").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
    END.
    WHEN "CustomerNote" THEN DO:
      ASSIGN pbPrimary = "CustomerNoteId" pbSequence = "SeqCustomerNoteId".
      pbIgnored = pbAddField("CustomerNoteId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("EmployeeId", 7, "int64", 0, 0, "Employee", "EmployeeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("NoteKind", 8, "character", 10, 0, "", "", FALSE, 0, "literal", "CALL", "").
      pbIgnored = pbAddField("NoteDateTime", 9, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("Summary", 10, "character", 300, 0, "", "", FALSE, 0, "wide-text", "Synthetic banking records and customer service. ", "").
      pbIgnored = pbAddField("NoteText", 11, "clob", 0, 0, "", "", FALSE, 1200, "lob", "1200", "").
      pbIgnored = pbAddField("FollowUpDate", 12, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("IsResolved", 13, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbRequirement("table", "CustomerNote", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("field", "CustomerNote", "CustomerNoteId", "int64").
      pbIgnored = pbRequirement("field", "CustomerNote", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CustomerNote", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CustomerNote", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CustomerNote", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerNote", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "CustomerNote", "EmployeeId", "int64").
      pbIgnored = pbRequirement("field", "CustomerNote", "NoteKind", "character").
      pbIgnored = pbRequirement("field", "CustomerNote", "NoteDateTime", "datetime-tz").
      pbIgnored = pbRequirement("field", "CustomerNote", "Summary", "character").
      pbIgnored = pbRequirement("field", "CustomerNote", "NoteText", "clob").
      pbIgnored = pbRequirement("field", "CustomerNote", "FollowUpDate", "date").
      pbIgnored = pbRequirement("field", "CustomerNote", "IsResolved", "logical").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("index", "CustomerNote", "PkCustomerNote", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "IxCustomerDate", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "IxEmployeeDate", "").
      pbIgnored = pbRequirement("index", "CustomerNote", "WxSummary", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
    END.
    WHEN "Account" THEN DO:
      ASSIGN pbPrimary = "AccountId" pbSequence = "SeqAccountId".
      pbIgnored = pbAddField("AccountId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountNumber", 6, "character", 14, 0, "", "", FALSE, 0, "unique-text", "PB", "decimal").
      pbIgnored = pbAddField("AccountTypeId", 7, "int64", 0, 0, "AccountType", "AccountTypeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("BranchId", 8, "int64", 0, 0, "Branch", "BranchId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("CurrencyCode", 9, "character", 3, 0, "Currency", "CurrencyCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AccountStatus", 10, "character", 8, 0, "", "", FALSE, 0, "literal", "OPEN", "").
      pbIgnored = pbAddField("OpenDate", 11, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("CloseDate", 12, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("CurrentBalance", 13, "decimal", 0, 2, "", "", FALSE, 0, "literal", "1250.5", "").
      pbIgnored = pbAddField("AvailableBalance", 14, "decimal", 0, 2, "", "", FALSE, 0, "literal", "1200.5", "").
      pbIgnored = pbAddField("OverdraftLimit", 15, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("InterestRate", 16, "decimal", 0, 4, "", "", FALSE, 0, "literal", "2.5", "").
      pbIgnored = pbAddField("Nickname", 17, "character", 40, 0, "", "", FALSE, 0, "literal", "Everyday banking", "").
      pbIgnored = pbAddField("LastStatementDate", 18, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("LastActivityAt", 19, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("UpdatedAt", 20, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "AccountType", "", "").
      pbIgnored = pbRequirement("table", "Branch", "", "").
      pbIgnored = pbRequirement("table", "Currency", "", "").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Account", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Account", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Account", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Account", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Account", "AccountNumber", "character").
      pbIgnored = pbRequirement("field", "Account", "AccountTypeId", "int64").
      pbIgnored = pbRequirement("field", "Account", "BranchId", "int64").
      pbIgnored = pbRequirement("field", "Account", "CurrencyCode", "character").
      pbIgnored = pbRequirement("field", "Account", "AccountStatus", "character").
      pbIgnored = pbRequirement("field", "Account", "OpenDate", "date").
      pbIgnored = pbRequirement("field", "Account", "CloseDate", "date").
      pbIgnored = pbRequirement("field", "Account", "CurrentBalance", "decimal").
      pbIgnored = pbRequirement("field", "Account", "AvailableBalance", "decimal").
      pbIgnored = pbRequirement("field", "Account", "OverdraftLimit", "decimal").
      pbIgnored = pbRequirement("field", "Account", "InterestRate", "decimal").
      pbIgnored = pbRequirement("field", "Account", "Nickname", "character").
      pbIgnored = pbRequirement("field", "Account", "LastStatementDate", "date").
      pbIgnored = pbRequirement("field", "Account", "LastActivityAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Account", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AccountType", "AccountTypeId", "int64").
      pbIgnored = pbRequirement("field", "Branch", "BranchId", "int64").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyCode", "character").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "Account", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Account", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Account", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Account", "UxAccountNumber", "").
      pbIgnored = pbRequirement("index", "Account", "IxAccountType", "").
      pbIgnored = pbRequirement("index", "Account", "IxBranchStatus", "").
      pbIgnored = pbRequirement("index", "Account", "IxCurrency", "").
      pbIgnored = pbRequirement("index", "AccountType", "PkAccountType", "").
      pbIgnored = pbRequirement("index", "Branch", "PkBranch", "").
      pbIgnored = pbRequirement("index", "Currency", "UxCurrencyCode", "").
      pbIgnored = pbUnique("UxAccountNumber", "AccountNumber").
    END.
    WHEN "AccountHolder" THEN DO:
      ASSIGN pbPrimary = "AccountHolderId" pbSequence = "SeqAccountHolderId".
      pbIgnored = pbAddField("AccountHolderId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("CustomerId", 7, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("HolderRole", 8, "character", 10, 0, "", "", FALSE, 0, "literal", "JOINT", "").
      pbIgnored = pbAddField("OwnershipPercent", 9, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("AddedDate", 10, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("UpdatedAt", 11, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "AccountHolder", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "AccountHolder", "AccountHolderId", "int64").
      pbIgnored = pbRequirement("field", "AccountHolder", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "AccountHolder", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "AccountHolder", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "AccountHolder", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AccountHolder", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "AccountHolder", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "AccountHolder", "HolderRole", "character").
      pbIgnored = pbRequirement("field", "AccountHolder", "OwnershipPercent", "decimal").
      pbIgnored = pbRequirement("field", "AccountHolder", "AddedDate", "date").
      pbIgnored = pbRequirement("field", "AccountHolder", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("index", "AccountHolder", "PkAccountHolder", "").
      pbIgnored = pbRequirement("index", "AccountHolder", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "AccountHolder", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "AccountHolder", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "AccountHolder", "UxAccountCustomer", "").
      pbIgnored = pbRequirement("index", "AccountHolder", "IxCustomerAccount", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbUnique("UxAccountCustomer", "AccountId,CustomerId").
    END.
    WHEN "Payee" THEN DO:
      ASSIGN pbPrimary = "PayeeId" pbSequence = "SeqPayeeId".
      pbIgnored = pbAddField("PayeeId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("PayeeName", 7, "character", 80, 0, "", "", FALSE, 0, "literal", "ParkBench PayeeName", "").
      pbIgnored = pbAddField("PayeeKind", 8, "character", 10, 0, "", "", FALSE, 0, "literal", "BILLER", "").
      pbIgnored = pbAddField("BankRoutingNumber", 9, "character", 9, 0, "", "", FALSE, 0, "literal", "021000021", "").
      pbIgnored = pbAddField("AccountNumberMasked", 10, "character", 20, 0, "", "", FALSE, 0, "literal", "****1234", "").
      pbIgnored = pbAddField("ReferenceText", 11, "character", 40, 0, "", "", FALSE, 0, "literal", "ParkBench ReferenceText", "").
      pbIgnored = pbAddField("Email", 12, "character", 80, 0, "", "", FALSE, 0, "literal", "alex.taylor@example.test", "").
      pbIgnored = pbAddField("AddressLine1", 13, "character", 60, 0, "", "", FALSE, 0, "literal", "25 Park Avenue", "").
      pbIgnored = pbAddField("City", 14, "character", 40, 0, "", "", FALSE, 0, "literal", "Bucharest", "").
      pbIgnored = pbAddField("PostalCode", 15, "character", 10, 0, "", "", FALSE, 0, "literal", "010101", "").
      pbIgnored = pbAddField("IsFavorite", 16, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("LastPaidDate", 17, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("UpdatedAt", 18, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Payee", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "Payee", "PayeeId", "int64").
      pbIgnored = pbRequirement("field", "Payee", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Payee", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Payee", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Payee", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Payee", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Payee", "PayeeName", "character").
      pbIgnored = pbRequirement("field", "Payee", "PayeeKind", "character").
      pbIgnored = pbRequirement("field", "Payee", "BankRoutingNumber", "character").
      pbIgnored = pbRequirement("field", "Payee", "AccountNumberMasked", "character").
      pbIgnored = pbRequirement("field", "Payee", "ReferenceText", "character").
      pbIgnored = pbRequirement("field", "Payee", "Email", "character").
      pbIgnored = pbRequirement("field", "Payee", "AddressLine1", "character").
      pbIgnored = pbRequirement("field", "Payee", "City", "character").
      pbIgnored = pbRequirement("field", "Payee", "PostalCode", "character").
      pbIgnored = pbRequirement("field", "Payee", "IsFavorite", "logical").
      pbIgnored = pbRequirement("field", "Payee", "LastPaidDate", "date").
      pbIgnored = pbRequirement("field", "Payee", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("index", "Payee", "PkPayee", "").
      pbIgnored = pbRequirement("index", "Payee", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Payee", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Payee", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Payee", "IxCustomerName", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
    END.
    WHEN "ScheduledPayment" THEN DO:
      ASSIGN pbPrimary = "ScheduledPaymentId" pbSequence = "SeqScheduledPaymentId".
      pbIgnored = pbAddField("ScheduledPaymentId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("PayeeId", 7, "int64", 0, 0, "Payee", "PayeeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("Amount", 8, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("Frequency", 9, "character", 10, 0, "", "", FALSE, 0, "literal", "MONTHLY", "").
      pbIgnored = pbAddField("NextRunDate", 10, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("EndDate", 11, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("Memo", 12, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench Memo", "").
      pbIgnored = pbAddField("PaymentStatus", 13, "character", 10, 0, "", "", FALSE, 0, "literal", "ACTIVE", "").
      pbIgnored = pbAddField("RunCount", 14, "integer", 0, 0, "", "", FALSE, 0, "literal", "1", "").
      pbIgnored = pbAddField("LastRunAt", 15, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("UpdatedAt", 16, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "ScheduledPayment", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "Payee", "", "").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "ScheduledPaymentId", "int64").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "PayeeId", "int64").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "Amount", "decimal").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "Frequency", "character").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "NextRunDate", "date").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "EndDate", "date").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "Memo", "character").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "PaymentStatus", "character").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "RunCount", "integer").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "LastRunAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "ScheduledPayment", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Payee", "PayeeId", "int64").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "PkScheduledPayment", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxAccount", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxPayee", "").
      pbIgnored = pbRequirement("index", "ScheduledPayment", "IxStatusNextRun", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "Payee", "PkPayee", "").
    END.
    WHEN "Card" THEN DO:
      ASSIGN pbPrimary = "CardId" pbSequence = "SeqCardId".
      pbIgnored = pbAddField("CardId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CardToken", 6, "character", 32, 0, "", "", FALSE, 0, "unique-text", "C", "hex").
      pbIgnored = pbAddField("CardNumberMasked", 7, "character", 19, 0, "", "", FALSE, 0, "literal", "**** **** **** 1234", "").
      pbIgnored = pbAddField("AccountId", 8, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("CustomerId", 9, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("CardKind", 10, "character", 8, 0, "", "", FALSE, 0, "literal", "DEBIT", "").
      pbIgnored = pbAddField("Network", 11, "character", 10, 0, "", "", FALSE, 0, "literal", "VISA", "").
      pbIgnored = pbAddField("EmbossedName", 12, "character", 26, 0, "", "", FALSE, 0, "literal", "ALEX TAYLOR", "").
      pbIgnored = pbAddField("ExpiryMonth", 13, "integer", 0, 0, "", "", FALSE, 0, "literal", "10", "").
      pbIgnored = pbAddField("ExpiryYear", 14, "integer", 0, 0, "", "", FALSE, 0, "literal", "2029", "").
      pbIgnored = pbAddField("IssueDate", 15, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("CardStatus", 16, "character", 10, 0, "", "", FALSE, 0, "literal", "ACTIVE", "").
      pbIgnored = pbAddField("DailyLimit", 17, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("IsContactless", 18, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("UpdatedAt", 19, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Card", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "Card", "CardId", "int64").
      pbIgnored = pbRequirement("field", "Card", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Card", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Card", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Card", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Card", "CardToken", "character").
      pbIgnored = pbRequirement("field", "Card", "CardNumberMasked", "character").
      pbIgnored = pbRequirement("field", "Card", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Card", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Card", "CardKind", "character").
      pbIgnored = pbRequirement("field", "Card", "Network", "character").
      pbIgnored = pbRequirement("field", "Card", "EmbossedName", "character").
      pbIgnored = pbRequirement("field", "Card", "ExpiryMonth", "integer").
      pbIgnored = pbRequirement("field", "Card", "ExpiryYear", "integer").
      pbIgnored = pbRequirement("field", "Card", "IssueDate", "date").
      pbIgnored = pbRequirement("field", "Card", "CardStatus", "character").
      pbIgnored = pbRequirement("field", "Card", "DailyLimit", "decimal").
      pbIgnored = pbRequirement("field", "Card", "IsContactless", "logical").
      pbIgnored = pbRequirement("field", "Card", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("index", "Card", "PkCard", "").
      pbIgnored = pbRequirement("index", "Card", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Card", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Card", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Card", "UxCardToken", "").
      pbIgnored = pbRequirement("index", "Card", "IxAccount", "").
      pbIgnored = pbRequirement("index", "Card", "IxCustomer", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbUnique("UxCardToken", "CardToken").
    END.
    WHEN "Loan" THEN DO:
      ASSIGN pbPrimary = "LoanId" pbSequence = "SeqLoanId".
      pbIgnored = pbAddField("LoanId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("LoanNumber", 6, "character", 14, 0, "", "", FALSE, 0, "unique-text", "L", "decimal").
      pbIgnored = pbAddField("CustomerId", 7, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("DisbursementAccountId", 8, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("LoanOfficerEmployeeId", 9, "int64", 0, 0, "Employee", "EmployeeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("LoanKind", 10, "character", 10, 0, "", "", FALSE, 0, "literal", "PERSONAL", "").
      pbIgnored = pbAddField("PrincipalAmount", 11, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("InterestRate", 12, "decimal", 0, 4, "", "", FALSE, 0, "literal", "2.5", "").
      pbIgnored = pbAddField("TermMonths", 13, "integer", 0, 0, "", "", FALSE, 0, "literal", "36", "").
      pbIgnored = pbAddField("OriginationDate", 14, "date", 0, 0, "", "", FALSE, 0, "date", "2015-01-01", "").
      pbIgnored = pbAddField("MaturityDate", 15, "date", 0, 0, "", "", FALSE, 0, "date", "2029-10-01", "").
      pbIgnored = pbAddField("MonthlyPaymentAmount", 16, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("OutstandingPrincipal", 17, "decimal", 0, 2, "", "", FALSE, 0, "literal", "25000", "").
      pbIgnored = pbAddField("NextPaymentDate", 18, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("LoanStatus", 19, "character", 10, 0, "", "", FALSE, 0, "literal", "CURRENT", "").
      pbIgnored = pbAddField("CollateralDescription", 20, "character", 400, 0, "", "", FALSE, 0, "wide-text", "Synthetic banking records and customer service. ", "").
      pbIgnored = pbAddField("UnderwritingNotes", 21, "character", 300, 0, "", "", FALSE, 0, "wide-text", "Synthetic banking records and customer service. ", "").
      pbIgnored = pbAddField("UpdatedAt", 22, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "Loan", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("field", "Loan", "LoanId", "int64").
      pbIgnored = pbRequirement("field", "Loan", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Loan", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Loan", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Loan", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Loan", "LoanNumber", "character").
      pbIgnored = pbRequirement("field", "Loan", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Loan", "DisbursementAccountId", "int64").
      pbIgnored = pbRequirement("field", "Loan", "LoanOfficerEmployeeId", "int64").
      pbIgnored = pbRequirement("field", "Loan", "LoanKind", "character").
      pbIgnored = pbRequirement("field", "Loan", "PrincipalAmount", "decimal").
      pbIgnored = pbRequirement("field", "Loan", "InterestRate", "decimal").
      pbIgnored = pbRequirement("field", "Loan", "TermMonths", "integer").
      pbIgnored = pbRequirement("field", "Loan", "OriginationDate", "date").
      pbIgnored = pbRequirement("field", "Loan", "MaturityDate", "date").
      pbIgnored = pbRequirement("field", "Loan", "MonthlyPaymentAmount", "decimal").
      pbIgnored = pbRequirement("field", "Loan", "OutstandingPrincipal", "decimal").
      pbIgnored = pbRequirement("field", "Loan", "NextPaymentDate", "date").
      pbIgnored = pbRequirement("field", "Loan", "LoanStatus", "character").
      pbIgnored = pbRequirement("field", "Loan", "CollateralDescription", "character").
      pbIgnored = pbRequirement("field", "Loan", "UnderwritingNotes", "character").
      pbIgnored = pbRequirement("field", "Loan", "UpdatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("index", "Loan", "PkLoan", "").
      pbIgnored = pbRequirement("index", "Loan", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Loan", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Loan", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Loan", "UxLoanNumber", "").
      pbIgnored = pbRequirement("index", "Loan", "IxCustomer", "").
      pbIgnored = pbRequirement("index", "Loan", "IxStatusNextPayment", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
      pbIgnored = pbUnique("UxLoanNumber", "LoanNumber").
    END.
    WHEN "StatementDocument" THEN DO:
      ASSIGN pbPrimary = "StatementDocumentId" pbSequence = "SeqStatementDocumentId".
      pbIgnored = pbAddField("StatementDocumentId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountStatementId", 6, "int64", 0, 0, "AccountStatement", "AccountStatementId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("DocumentFormat", 7, "character", 8, 0, "", "", FALSE, 0, "literal", "PDF", "").
      pbIgnored = pbAddField("PageCount", 8, "integer", 0, 0, "", "", FALSE, 0, "literal", "2", "").
      pbIgnored = pbAddField("Checksum", 9, "character", 64, 0, "", "", FALSE, 0, "companion", "PdfContent", "").
      pbIgnored = pbAddField("RenderedAt", 10, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("PdfContent", 11, "blob", 0, 0, "", "", FALSE, 8192, "lob", "8192", "").
      pbIgnored = pbAddField("StatementXml", 12, "clob", 0, 0, "", "", FALSE, 3072, "lob", "3072", "").
      pbIgnored = pbRequirement("table", "StatementDocument", "", "").
      pbIgnored = pbRequirement("table", "AccountStatement", "", "").
      pbIgnored = pbRequirement("field", "StatementDocument", "StatementDocumentId", "int64").
      pbIgnored = pbRequirement("field", "StatementDocument", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "StatementDocument", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "StatementDocument", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "StatementDocument", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "StatementDocument", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "StatementDocument", "DocumentFormat", "character").
      pbIgnored = pbRequirement("field", "StatementDocument", "PageCount", "integer").
      pbIgnored = pbRequirement("field", "StatementDocument", "Checksum", "character").
      pbIgnored = pbRequirement("field", "StatementDocument", "RenderedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "StatementDocument", "PdfContent", "blob").
      pbIgnored = pbRequirement("field", "StatementDocument", "StatementXml", "clob").
      pbIgnored = pbRequirement("field", "AccountStatement", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("index", "StatementDocument", "PkStatementDocument", "").
      pbIgnored = pbRequirement("index", "StatementDocument", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "StatementDocument", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "StatementDocument", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "StatementDocument", "UxAccountStatement", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "PkAccountStatement", "").
      pbIgnored = pbUnique("UxAccountStatement", "AccountStatementId").
    END.
    WHEN "AccountStatement" THEN DO:
      ASSIGN pbPrimary = "AccountStatementId" pbSequence = "SeqAccountStatementId".
      pbIgnored = pbAddField("AccountStatementId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("PeriodStart", 7, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("PeriodEnd", 8, "date", 0, 0, "", "", FALSE, 0, "unique-date", "2030-01-01", "month-end").
      pbIgnored = pbAddField("OpeningBalance", 9, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("ClosingBalance", 10, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("TotalDebits", 11, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("TotalCredits", 12, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("DebitCount", 13, "integer", 0, 0, "", "", FALSE, 0, "literal", "5", "").
      pbIgnored = pbAddField("CreditCount", 14, "integer", 0, 0, "", "", FALSE, 0, "literal", "3", "").
      pbIgnored = pbAddField("InterestEarned", 15, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("FeesCharged", 16, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("DeliveryMethod", 17, "character", 6, 0, "", "", FALSE, 0, "literal", "EMAIL", "").
      pbIgnored = pbAddField("GeneratedAt", 18, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("NoticeText", 19, "clob", 0, 0, "", "", FALSE, 1536, "lob", "1536", "").
      pbIgnored = pbRequirement("table", "AccountStatement", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("field", "AccountStatement", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "AccountStatement", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "AccountStatement", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "AccountStatement", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "AccountStatement", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AccountStatement", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "AccountStatement", "PeriodStart", "date").
      pbIgnored = pbRequirement("field", "AccountStatement", "PeriodEnd", "date").
      pbIgnored = pbRequirement("field", "AccountStatement", "OpeningBalance", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "ClosingBalance", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "TotalDebits", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "TotalCredits", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "DebitCount", "integer").
      pbIgnored = pbRequirement("field", "AccountStatement", "CreditCount", "integer").
      pbIgnored = pbRequirement("field", "AccountStatement", "InterestEarned", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "FeesCharged", "decimal").
      pbIgnored = pbRequirement("field", "AccountStatement", "DeliveryMethod", "character").
      pbIgnored = pbRequirement("field", "AccountStatement", "GeneratedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AccountStatement", "NoticeText", "clob").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("index", "AccountStatement", "PkAccountStatement", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "UxAccountPeriod", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "IxPeriodEnd", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbUnique("UxAccountPeriod", "AccountId,PeriodEnd").
    END.
    WHEN "MonthlyBalance" THEN DO:
      ASSIGN pbPrimary = "MonthlyBalanceId" pbSequence = "SeqMonthlyBalanceId".
      pbIgnored = pbAddField("MonthlyBalanceId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("BalanceMonth", 7, "date", 0, 0, "", "", FALSE, 0, "unique-date", "2030-01-01", "month").
      pbIgnored = pbAddField("OpeningBalance", 8, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("ClosingBalance", 9, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("MinimumBalance", 10, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("MaximumBalance", 11, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("AverageDailyBalance", 12, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("TotalDebits", 13, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("TotalCredits", 14, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("DebitCount", 15, "integer", 0, 0, "", "", FALSE, 0, "literal", "5", "").
      pbIgnored = pbAddField("CreditCount", 16, "integer", 0, 0, "", "", FALSE, 0, "literal", "3", "").
      pbIgnored = pbAddField("DaysOverdrawn", 17, "integer", 0, 0, "", "", FALSE, 0, "literal", "0", "").
      pbIgnored = pbRequirement("table", "MonthlyBalance", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "MonthlyBalanceId", "int64").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "BalanceMonth", "date").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "OpeningBalance", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "ClosingBalance", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "MinimumBalance", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "MaximumBalance", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "AverageDailyBalance", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "TotalDebits", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "TotalCredits", "decimal").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "DebitCount", "integer").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "CreditCount", "integer").
      pbIgnored = pbRequirement("field", "MonthlyBalance", "DaysOverdrawn", "integer").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "PkMonthlyBalance", "").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "UxAccountMonth", "").
      pbIgnored = pbRequirement("index", "MonthlyBalance", "IxBalanceMonth", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbUnique("UxAccountMonth", "AccountId,BalanceMonth").
    END.
    WHEN "CreditTransaction" THEN DO:
      ASSIGN pbPrimary = "CreditTransactionId" pbSequence = "SeqCreditTransactionId".
      pbIgnored = pbAddField("CreditTransactionId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("TransactionTypeId", 7, "int64", 0, 0, "TransactionType", "TransactionTypeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AccountStatementId", 8, "int64", 0, 0, "AccountStatement", "AccountStatementId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbAddField("PostedDate", 9, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("PostedAt", 10, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("Amount", 11, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("RunningBalance", 12, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("Description", 13, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench Description", "").
      pbIgnored = pbAddField("PayerName", 14, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench PayerName", "").
      pbIgnored = pbAddField("ReferenceNumber", 15, "character", 20, 0, "", "", FALSE, 0, "literal", "ParkBench ReferenceN", "").
      pbIgnored = pbAddField("IsPayroll", 16, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbRequirement("table", "CreditTransaction", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "AccountStatement", "", "").
      pbIgnored = pbRequirement("table", "TransactionType", "", "").
      pbIgnored = pbRequirement("field", "CreditTransaction", "CreditTransactionId", "int64").
      pbIgnored = pbRequirement("field", "CreditTransaction", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CreditTransaction", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CreditTransaction", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CreditTransaction", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CreditTransaction", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "CreditTransaction", "TransactionTypeId", "int64").
      pbIgnored = pbRequirement("field", "CreditTransaction", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "CreditTransaction", "PostedDate", "date").
      pbIgnored = pbRequirement("field", "CreditTransaction", "PostedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CreditTransaction", "Amount", "decimal").
      pbIgnored = pbRequirement("field", "CreditTransaction", "RunningBalance", "decimal").
      pbIgnored = pbRequirement("field", "CreditTransaction", "Description", "character").
      pbIgnored = pbRequirement("field", "CreditTransaction", "PayerName", "character").
      pbIgnored = pbRequirement("field", "CreditTransaction", "ReferenceNumber", "character").
      pbIgnored = pbRequirement("field", "CreditTransaction", "IsPayroll", "logical").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "TransactionType", "TransactionTypeId", "int64").
      pbIgnored = pbRequirement("field", "AccountStatement", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "TransactionType", "Direction", "character").
      pbIgnored = pbRequirement("index", "CreditTransaction", "PkCreditTransaction", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxAccountPosted", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxAccountStatement", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "IxPostedDate", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "TransactionType", "PkTransactionType", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "PkAccountStatement", "").
    END.
    WHEN "Transfer" THEN DO:
      ASSIGN pbPrimary = "TransferId" pbSequence = "SeqTransferId".
      pbIgnored = pbAddField("TransferId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("FromAccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("ToAccountId", 7, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("Amount", 8, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("TransferDateTime", 9, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("DebitTransactionId", 10, "int64", 0, 0, "DebitTransaction", "DebitTransactionId", FALSE, 0, "parent-unique", "", "").
      pbIgnored = pbAddField("CreditTransactionId", 11, "int64", 0, 0, "CreditTransaction", "CreditTransactionId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("TransferStatus", 12, "character", 10, 0, "", "", FALSE, 0, "literal", "POSTED", "").
      pbIgnored = pbAddField("Channel", 13, "character", 8, 0, "", "", FALSE, 0, "literal", "ONLINE", "").
      pbIgnored = pbRequirement("table", "Transfer", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "CreditTransaction", "", "").
      pbIgnored = pbRequirement("table", "DebitTransaction", "", "").
      pbIgnored = pbRequirement("field", "Transfer", "TransferId", "int64").
      pbIgnored = pbRequirement("field", "Transfer", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "Transfer", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "Transfer", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "Transfer", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "Transfer", "FromAccountId", "int64").
      pbIgnored = pbRequirement("field", "Transfer", "ToAccountId", "int64").
      pbIgnored = pbRequirement("field", "Transfer", "Amount", "decimal").
      pbIgnored = pbRequirement("field", "Transfer", "TransferDateTime", "datetime-tz").
      pbIgnored = pbRequirement("field", "Transfer", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("field", "Transfer", "CreditTransactionId", "int64").
      pbIgnored = pbRequirement("field", "Transfer", "TransferStatus", "character").
      pbIgnored = pbRequirement("field", "Transfer", "Channel", "character").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("field", "CreditTransaction", "CreditTransactionId", "int64").
      pbIgnored = pbRequirement("index", "Transfer", "PkTransfer", "").
      pbIgnored = pbRequirement("index", "Transfer", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "Transfer", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "Transfer", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Transfer", "IxFromAccount", "").
      pbIgnored = pbRequirement("index", "Transfer", "IxToAccount", "").
      pbIgnored = pbRequirement("index", "Transfer", "UxDebitTransaction", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "PkDebitTransaction", "").
      pbIgnored = pbRequirement("index", "CreditTransaction", "PkCreditTransaction", "").
      pbIgnored = pbUnique("UxDebitTransaction", "DebitTransactionId").
    END.
    WHEN "LoanPayment" THEN DO:
      ASSIGN pbPrimary = "LoanPaymentId" pbSequence = "SeqLoanPaymentId".
      pbIgnored = pbAddField("LoanPaymentId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("LoanId", 6, "int64", 0, 0, "Loan", "LoanId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("DueDate", 7, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("PaymentDate", 8, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("AmountPaid", 9, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("PrincipalPortion", 10, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("InterestPortion", 11, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("LateFee", 12, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("DebitTransactionId", 13, "int64", 0, 0, "DebitTransaction", "DebitTransactionId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbRequirement("table", "LoanPayment", "", "").
      pbIgnored = pbRequirement("table", "DebitTransaction", "", "").
      pbIgnored = pbRequirement("table", "Loan", "", "").
      pbIgnored = pbRequirement("field", "LoanPayment", "LoanPaymentId", "int64").
      pbIgnored = pbRequirement("field", "LoanPayment", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "LoanPayment", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "LoanPayment", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "LoanPayment", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "LoanPayment", "LoanId", "int64").
      pbIgnored = pbRequirement("field", "LoanPayment", "DueDate", "date").
      pbIgnored = pbRequirement("field", "LoanPayment", "PaymentDate", "date").
      pbIgnored = pbRequirement("field", "LoanPayment", "AmountPaid", "decimal").
      pbIgnored = pbRequirement("field", "LoanPayment", "PrincipalPortion", "decimal").
      pbIgnored = pbRequirement("field", "LoanPayment", "InterestPortion", "decimal").
      pbIgnored = pbRequirement("field", "LoanPayment", "LateFee", "decimal").
      pbIgnored = pbRequirement("field", "LoanPayment", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("field", "Loan", "LoanId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("index", "LoanPayment", "PkLoanPayment", "").
      pbIgnored = pbRequirement("index", "LoanPayment", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "LoanPayment", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "LoanPayment", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "LoanPayment", "IxLoanPayment", "").
      pbIgnored = pbRequirement("index", "LoanPayment", "IxDueDate", "").
      pbIgnored = pbRequirement("index", "Loan", "PkLoan", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "PkDebitTransaction", "").
    END.
    WHEN "LoginEvent" THEN DO:
      ASSIGN pbPrimary = "LoginEventId" pbSequence = "SeqLoginEventId".
      pbIgnored = pbAddField("LoginEventId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CustomerId", 6, "int64", 0, 0, "Customer", "CustomerId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("EventDateTime", 7, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("EventKind", 8, "character", 8, 0, "", "", FALSE, 0, "literal", "LOGIN", "").
      pbIgnored = pbAddField("Channel", 9, "character", 6, 0, "", "", FALSE, 0, "literal", "ONLINE", "").
      pbIgnored = pbAddField("IpAddress", 10, "character", 39, 0, "", "", FALSE, 0, "literal", "192.0.2.1", "").
      pbIgnored = pbAddField("DeviceId", 11, "character", 32, 0, "", "", FALSE, 0, "literal", "ParkBench DeviceId", "").
      pbIgnored = pbAddField("IsSuccess", 12, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("SessionSeconds", 13, "integer", 0, 0, "", "", FALSE, 0, "literal", "120", "").
      pbIgnored = pbRequirement("table", "LoginEvent", "", "").
      pbIgnored = pbRequirement("table", "Customer", "", "").
      pbIgnored = pbRequirement("field", "LoginEvent", "LoginEventId", "int64").
      pbIgnored = pbRequirement("field", "LoginEvent", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "LoginEvent", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "LoginEvent", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "LoginEvent", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "LoginEvent", "CustomerId", "int64").
      pbIgnored = pbRequirement("field", "LoginEvent", "EventDateTime", "datetime-tz").
      pbIgnored = pbRequirement("field", "LoginEvent", "EventKind", "character").
      pbIgnored = pbRequirement("field", "LoginEvent", "Channel", "character").
      pbIgnored = pbRequirement("field", "LoginEvent", "IpAddress", "character").
      pbIgnored = pbRequirement("field", "LoginEvent", "DeviceId", "character").
      pbIgnored = pbRequirement("field", "LoginEvent", "IsSuccess", "logical").
      pbIgnored = pbRequirement("field", "LoginEvent", "SessionSeconds", "integer").
      pbIgnored = pbRequirement("field", "Customer", "CustomerId", "int64").
      pbIgnored = pbRequirement("index", "LoginEvent", "PkLoginEvent", "").
      pbIgnored = pbRequirement("index", "LoginEvent", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "LoginEvent", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "LoginEvent", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "LoginEvent", "IxCustomerTime", "").
      pbIgnored = pbRequirement("index", "Customer", "PkCustomer", "").
    END.
    WHEN "DebitTransaction" THEN DO:
      ASSIGN pbPrimary = "DebitTransactionId" pbSequence = "SeqDebitTransactionId".
      pbIgnored = pbAddField("DebitTransactionId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("AccountId", 6, "int64", 0, 0, "Account", "AccountId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("TransactionTypeId", 7, "int64", 0, 0, "TransactionType", "TransactionTypeId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AccountStatementId", 8, "int64", 0, 0, "AccountStatement", "AccountStatementId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbAddField("MerchantId", 9, "int64", 0, 0, "Merchant", "MerchantId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbAddField("PostedDate", 10, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("PostedAt", 11, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("Amount", 12, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("RunningBalance", 13, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("Description", 14, "character", 60, 0, "", "", FALSE, 0, "literal", "ParkBench Description", "").
      pbIgnored = pbAddField("ReferenceNumber", 15, "character", 20, 0, "", "", FALSE, 0, "literal", "ParkBench ReferenceN", "").
      pbIgnored = pbAddField("CheckNumber", 16, "integer", 0, 0, "", "", FALSE, 0, "literal", "0", "").
      pbIgnored = pbRequirement("table", "DebitTransaction", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("table", "AccountStatement", "", "").
      pbIgnored = pbRequirement("table", "Merchant", "", "").
      pbIgnored = pbRequirement("table", "TransactionType", "", "").
      pbIgnored = pbRequirement("field", "DebitTransaction", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "DebitTransaction", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "DebitTransaction", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "DebitTransaction", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "DebitTransaction", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "TransactionTypeId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "MerchantId", "int64").
      pbIgnored = pbRequirement("field", "DebitTransaction", "PostedDate", "date").
      pbIgnored = pbRequirement("field", "DebitTransaction", "PostedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "DebitTransaction", "Amount", "decimal").
      pbIgnored = pbRequirement("field", "DebitTransaction", "RunningBalance", "decimal").
      pbIgnored = pbRequirement("field", "DebitTransaction", "Description", "character").
      pbIgnored = pbRequirement("field", "DebitTransaction", "ReferenceNumber", "character").
      pbIgnored = pbRequirement("field", "DebitTransaction", "CheckNumber", "integer").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("field", "TransactionType", "TransactionTypeId", "int64").
      pbIgnored = pbRequirement("field", "AccountStatement", "AccountStatementId", "int64").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantId", "int64").
      pbIgnored = pbRequirement("field", "TransactionType", "Direction", "character").
      pbIgnored = pbRequirement("index", "DebitTransaction", "PkDebitTransaction", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxAccountPosted", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxAccountStatement", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxPostedDate", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "IxMerchantDate", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
      pbIgnored = pbRequirement("index", "TransactionType", "PkTransactionType", "").
      pbIgnored = pbRequirement("index", "AccountStatement", "PkAccountStatement", "").
      pbIgnored = pbRequirement("index", "Merchant", "PkMerchant", "").
    END.
    WHEN "CardAuthorization" THEN DO:
      ASSIGN pbPrimary = "CardAuthorizationId" pbSequence = "SeqCardAuthorizationId".
      pbIgnored = pbAddField("CardAuthorizationId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("CardId", 6, "int64", 0, 0, "Card", "CardId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("MerchantId", 7, "int64", 0, 0, "Merchant", "MerchantId", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AuthDateTime", 8, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("MerchantLocalDateTime", 9, "datetime", 0, 0, "", "", FALSE, 0, "datetime", "", "").
      pbIgnored = pbAddField("Amount", 10, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("CurrencyCode", 11, "character", 3, 0, "Currency", "CurrencyCode", FALSE, 0, "parent", "", "").
      pbIgnored = pbAddField("AuthCode", 12, "character", 6, 0, "", "", FALSE, 0, "literal", "ParkBe", "").
      pbIgnored = pbAddField("ResponseCode", 13, "character", 2, 0, "", "", FALSE, 0, "literal", "00", "").
      pbIgnored = pbAddField("IsApproved", 14, "logical", 0, 0, "", "", FALSE, 0, "literal", "true", "").
      pbIgnored = pbAddField("EntryMode", 15, "character", 4, 0, "", "", FALSE, 0, "literal", "CHIP", "").
      pbIgnored = pbAddField("AuthKind", 16, "character", 9, 0, "", "", FALSE, 0, "literal", "FINAL", "").
      pbIgnored = pbAddField("DebitTransactionId", 17, "int64", 0, 0, "DebitTransaction", "DebitTransactionId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbRequirement("table", "CardAuthorization", "", "").
      pbIgnored = pbRequirement("table", "Card", "", "").
      pbIgnored = pbRequirement("table", "Currency", "", "").
      pbIgnored = pbRequirement("table", "DebitTransaction", "", "").
      pbIgnored = pbRequirement("table", "Merchant", "", "").
      pbIgnored = pbRequirement("field", "CardAuthorization", "CardAuthorizationId", "int64").
      pbIgnored = pbRequirement("field", "CardAuthorization", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "CardAuthorization", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "CardAuthorization", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "CardAuthorization", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "CardAuthorization", "CardId", "int64").
      pbIgnored = pbRequirement("field", "CardAuthorization", "MerchantId", "int64").
      pbIgnored = pbRequirement("field", "CardAuthorization", "AuthDateTime", "datetime-tz").
      pbIgnored = pbRequirement("field", "CardAuthorization", "MerchantLocalDateTime", "datetime").
      pbIgnored = pbRequirement("field", "CardAuthorization", "Amount", "decimal").
      pbIgnored = pbRequirement("field", "CardAuthorization", "CurrencyCode", "character").
      pbIgnored = pbRequirement("field", "CardAuthorization", "AuthCode", "character").
      pbIgnored = pbRequirement("field", "CardAuthorization", "ResponseCode", "character").
      pbIgnored = pbRequirement("field", "CardAuthorization", "IsApproved", "logical").
      pbIgnored = pbRequirement("field", "CardAuthorization", "EntryMode", "character").
      pbIgnored = pbRequirement("field", "CardAuthorization", "AuthKind", "character").
      pbIgnored = pbRequirement("field", "CardAuthorization", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("field", "Card", "CardId", "int64").
      pbIgnored = pbRequirement("field", "Merchant", "MerchantId", "int64").
      pbIgnored = pbRequirement("field", "Currency", "CurrencyCode", "character").
      pbIgnored = pbRequirement("field", "DebitTransaction", "DebitTransactionId", "int64").
      pbIgnored = pbRequirement("index", "CardAuthorization", "PkCardAuthorization", "").
      pbIgnored = pbRequirement("index", "CardAuthorization", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "CardAuthorization", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "CardAuthorization", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "CardAuthorization", "IxCardDate", "").
      pbIgnored = pbRequirement("index", "CardAuthorization", "IxMerchantDate", "").
      pbIgnored = pbRequirement("index", "Card", "PkCard", "").
      pbIgnored = pbRequirement("index", "Merchant", "PkMerchant", "").
      pbIgnored = pbRequirement("index", "Currency", "UxCurrencyCode", "").
      pbIgnored = pbRequirement("index", "DebitTransaction", "PkDebitTransaction", "").
    END.
    WHEN "AuditLog" THEN DO:
      ASSIGN pbPrimary = "AuditLogId" pbSequence = "SeqAuditLogId".
      pbIgnored = pbAddField("AuditLogId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("EventDateTime", 6, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("TableName", 7, "character", 32, 0, "", "", FALSE, 0, "literal", "Account", "").
      pbIgnored = pbAddField("RecordId", 8, "int64", 0, 0, "", "", FALSE, 0, "audit-reference", "Account", "").
      pbIgnored = pbAddField("AuditAction", 9, "character", 1, 0, "", "", FALSE, 0, "literal", "U", "").
      pbIgnored = pbAddField("EmployeeId", 10, "int64", 0, 0, "Employee", "EmployeeId", TRUE, 0, "absent-parent", "0", "").
      pbIgnored = pbAddField("ChangeSummary", 11, "character", 60, 0, "", "", FALSE, 0, "literal", "Synthetic banking attribute change", "").
      pbIgnored = pbRequirement("table", "AuditLog", "", "").
      pbIgnored = pbRequirement("table", "Employee", "", "").
      pbIgnored = pbRequirement("table", "Account", "", "").
      pbIgnored = pbRequirement("field", "AuditLog", "AuditLogId", "int64").
      pbIgnored = pbRequirement("field", "AuditLog", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "AuditLog", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "AuditLog", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "AuditLog", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "AuditLog", "EventDateTime", "datetime-tz").
      pbIgnored = pbRequirement("field", "AuditLog", "TableName", "character").
      pbIgnored = pbRequirement("field", "AuditLog", "RecordId", "int64").
      pbIgnored = pbRequirement("field", "AuditLog", "AuditAction", "character").
      pbIgnored = pbRequirement("field", "AuditLog", "EmployeeId", "int64").
      pbIgnored = pbRequirement("field", "AuditLog", "ChangeSummary", "character").
      pbIgnored = pbRequirement("field", "Employee", "EmployeeId", "int64").
      pbIgnored = pbRequirement("field", "Account", "AccountId", "int64").
      pbIgnored = pbRequirement("index", "AuditLog", "PkAuditLog", "").
      pbIgnored = pbRequirement("index", "AuditLog", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "AuditLog", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "AuditLog", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "Employee", "PkEmployee", "").
      pbIgnored = pbRequirement("index", "Account", "PkAccount", "").
    END.
    WHEN "BenchmarkTableInfo" THEN DO:
      ASSIGN pbPrimary = "BenchmarkTableInfoId" pbSequence = "SeqBenchmarkTableInfoId".
      pbIgnored = pbAddField("BenchmarkTableInfoId", 1, "int64", 0, 0, "", "", FALSE, 0, "sequence", "", "").
      pbIgnored = pbAddField("RandomInt10", 2, "integer", 0, 0, "", "", FALSE, 0, "random", "10", "").
      pbIgnored = pbAddField("RandomInt100", 3, "integer", 0, 0, "", "", FALSE, 0, "random", "100", "").
      pbIgnored = pbAddField("RandomInt1000", 4, "integer", 0, 0, "", "", FALSE, 0, "random", "1000", "").
      pbIgnored = pbAddField("CreatedAt", 5, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbAddField("TableName", 6, "character", 32, 0, "", "", FALSE, 0, "unique-text", "PBWrite", "decimal").
      pbIgnored = pbAddField("TableRowCount", 7, "int64", 0, 0, "", "", FALSE, 0, "literal", "1", "").
      pbIgnored = pbAddField("MaxId", 8, "int64", 0, 0, "", "", FALSE, 0, "literal", "1", "").
      pbIgnored = pbAddField("ScaleFactor", 9, "decimal", 0, 2, "", "", FALSE, 0, "literal", "125.5", "").
      pbIgnored = pbAddField("VolumeTier", 10, "character", 10, 0, "", "", FALSE, 0, "literal", "Tiny", "").
      pbIgnored = pbAddField("RecordSizeTier", 11, "character", 10, 0, "", "", FALSE, 0, "literal", "Narrow", "").
      pbIgnored = pbAddField("AsOfDate", 12, "date", 0, 0, "", "", FALSE, 0, "date", "2026-10-01", "").
      pbIgnored = pbAddField("LoadedAt", 13, "datetime-tz", 0, 0, "", "", FALSE, 0, "datetime-tz", "", "").
      pbIgnored = pbRequirement("table", "BenchmarkTableInfo", "", "").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "BenchmarkTableInfoId", "int64").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "RandomInt10", "integer").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "RandomInt100", "integer").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "RandomInt1000", "integer").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "CreatedAt", "datetime-tz").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "TableName", "character").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "TableRowCount", "int64").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "MaxId", "int64").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "ScaleFactor", "decimal").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "VolumeTier", "character").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "RecordSizeTier", "character").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "AsOfDate", "date").
      pbIgnored = pbRequirement("field", "BenchmarkTableInfo", "LoadedAt", "datetime-tz").
      pbIgnored = pbRequirement("index", "BenchmarkTableInfo", "PkBenchmarkTableInfo", "").
      pbIgnored = pbRequirement("index", "BenchmarkTableInfo", "IxRandomInt10", "").
      pbIgnored = pbRequirement("index", "BenchmarkTableInfo", "IxRandomInt100", "").
      pbIgnored = pbRequirement("index", "BenchmarkTableInfo", "IxRandomInt1000", "").
      pbIgnored = pbRequirement("index", "BenchmarkTableInfo", "UxTableName", "").
      pbIgnored = pbUnique("UxTableName", "TableName").
    END.
  END CASE.
  pbIgnored = pbDomain("Currency", 1, "CurrencyCode=USD|NumericCode=840|MinorUnits=2|CurrencyName=USD|CurrencySymbol=USD").
  pbIgnored = pbDomain("Currency", 2, "CurrencyCode=EUR|NumericCode=978|MinorUnits=2|CurrencyName=EUR|CurrencySymbol=EUR").
  pbIgnored = pbDomain("Currency", 3, "CurrencyCode=JPY|NumericCode=392|MinorUnits=0|CurrencyName=JPY|CurrencySymbol=JPY").
  pbIgnored = pbDomain("Currency", 4, "CurrencyCode=GBP|NumericCode=826|MinorUnits=2|CurrencyName=GBP|CurrencySymbol=GBP").
  pbIgnored = pbDomain("Currency", 5, "CurrencyCode=CNY|NumericCode=156|MinorUnits=2|CurrencyName=CNY|CurrencySymbol=CNY").
  pbIgnored = pbDomain("Currency", 6, "CurrencyCode=AUD|NumericCode=36|MinorUnits=2|CurrencyName=AUD|CurrencySymbol=AUD").
  pbIgnored = pbDomain("Currency", 7, "CurrencyCode=CAD|NumericCode=124|MinorUnits=2|CurrencyName=CAD|CurrencySymbol=CAD").
  pbIgnored = pbDomain("Currency", 8, "CurrencyCode=CHF|NumericCode=756|MinorUnits=2|CurrencyName=CHF|CurrencySymbol=CHF").
  pbIgnored = pbDomain("Currency", 9, "CurrencyCode=HKD|NumericCode=344|MinorUnits=2|CurrencyName=HKD|CurrencySymbol=HKD").
  pbIgnored = pbDomain("Currency", 10, "CurrencyCode=SGD|NumericCode=702|MinorUnits=2|CurrencyName=SGD|CurrencySymbol=SGD").
  pbIgnored = pbDomain("Currency", 11, "CurrencyCode=SEK|NumericCode=752|MinorUnits=2|CurrencyName=SEK|CurrencySymbol=SEK").
  pbIgnored = pbDomain("Currency", 12, "CurrencyCode=KRW|NumericCode=410|MinorUnits=0|CurrencyName=KRW|CurrencySymbol=KRW").
  pbIgnored = pbDomain("Currency", 13, "CurrencyCode=NOK|NumericCode=578|MinorUnits=2|CurrencyName=NOK|CurrencySymbol=NOK").
  pbIgnored = pbDomain("Currency", 14, "CurrencyCode=NZD|NumericCode=554|MinorUnits=2|CurrencyName=NZD|CurrencySymbol=NZD").
  pbIgnored = pbDomain("Currency", 15, "CurrencyCode=INR|NumericCode=356|MinorUnits=2|CurrencyName=INR|CurrencySymbol=INR").
  pbIgnored = pbDomain("Currency", 16, "CurrencyCode=MXN|NumericCode=484|MinorUnits=2|CurrencyName=MXN|CurrencySymbol=MXN").
  pbIgnored = pbDomain("Currency", 17, "CurrencyCode=TWD|NumericCode=901|MinorUnits=2|CurrencyName=TWD|CurrencySymbol=TWD").
  pbIgnored = pbDomain("Currency", 18, "CurrencyCode=ZAR|NumericCode=710|MinorUnits=2|CurrencyName=ZAR|CurrencySymbol=ZAR").
  pbIgnored = pbDomain("Currency", 19, "CurrencyCode=BRL|NumericCode=986|MinorUnits=2|CurrencyName=BRL|CurrencySymbol=BRL").
  pbIgnored = pbDomain("Currency", 20, "CurrencyCode=DKK|NumericCode=208|MinorUnits=2|CurrencyName=DKK|CurrencySymbol=DKK").
  pbIgnored = pbDomain("Currency", 21, "CurrencyCode=PLN|NumericCode=985|MinorUnits=2|CurrencyName=PLN|CurrencySymbol=PLN").
  pbIgnored = pbDomain("Currency", 22, "CurrencyCode=THB|NumericCode=764|MinorUnits=2|CurrencyName=THB|CurrencySymbol=THB").
  pbIgnored = pbDomain("Currency", 23, "CurrencyCode=ILS|NumericCode=376|MinorUnits=2|CurrencyName=ILS|CurrencySymbol=ILS").
  pbIgnored = pbDomain("Currency", 24, "CurrencyCode=IDR|NumericCode=360|MinorUnits=2|CurrencyName=IDR|CurrencySymbol=IDR").
  pbIgnored = pbDomain("Currency", 25, "CurrencyCode=CZK|NumericCode=203|MinorUnits=2|CurrencyName=CZK|CurrencySymbol=CZK").
  pbIgnored = pbDomain("Currency", 26, "CurrencyCode=AED|NumericCode=784|MinorUnits=2|CurrencyName=AED|CurrencySymbol=AED").
  pbIgnored = pbDomain("Currency", 27, "CurrencyCode=TRY|NumericCode=949|MinorUnits=2|CurrencyName=TRY|CurrencySymbol=TRY").
  pbIgnored = pbDomain("Currency", 28, "CurrencyCode=HUF|NumericCode=348|MinorUnits=2|CurrencyName=HUF|CurrencySymbol=HUF").
  pbIgnored = pbDomain("Currency", 29, "CurrencyCode=CLP|NumericCode=152|MinorUnits=0|CurrencyName=CLP|CurrencySymbol=CLP").
  pbIgnored = pbDomain("Currency", 30, "CurrencyCode=SAR|NumericCode=682|MinorUnits=2|CurrencyName=SAR|CurrencySymbol=SAR").
  pbIgnored = pbDomain("Currency", 31, "CurrencyCode=PHP|NumericCode=608|MinorUnits=2|CurrencyName=PHP|CurrencySymbol=PHP").
  pbIgnored = pbDomain("Currency", 32, "CurrencyCode=MYR|NumericCode=458|MinorUnits=2|CurrencyName=MYR|CurrencySymbol=MYR").
  pbIgnored = pbDomain("Currency", 33, "CurrencyCode=COP|NumericCode=170|MinorUnits=2|CurrencyName=COP|CurrencySymbol=COP").
  pbIgnored = pbDomain("Currency", 34, "CurrencyCode=RUB|NumericCode=643|MinorUnits=2|CurrencyName=RUB|CurrencySymbol=RUB").
  pbIgnored = pbDomain("Currency", 35, "CurrencyCode=RON|NumericCode=946|MinorUnits=2|CurrencyName=RON|CurrencySymbol=RON").
  pbIgnored = pbDomain("Currency", 36, "CurrencyCode=PEN|NumericCode=604|MinorUnits=2|CurrencyName=PEN|CurrencySymbol=PEN").
  pbIgnored = pbDomain("Currency", 37, "CurrencyCode=BHD|NumericCode=48|MinorUnits=3|CurrencyName=BHD|CurrencySymbol=BHD").
  pbIgnored = pbDomain("Currency", 38, "CurrencyCode=BGN|NumericCode=975|MinorUnits=2|CurrencyName=BGN|CurrencySymbol=BGN").
  pbIgnored = pbDomain("Currency", 39, "CurrencyCode=ARS|NumericCode=32|MinorUnits=2|CurrencyName=ARS|CurrencySymbol=ARS").
  pbIgnored = pbDomain("Currency", 40, "CurrencyCode=EGP|NumericCode=818|MinorUnits=2|CurrencyName=EGP|CurrencySymbol=EGP").
  pbIgnored = pbDomain("Country", 1, "CountryCode=AD|CountryName=Andorra|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 2, "CountryCode=AE|CountryName=United Arab Emirates|DefaultCurrencyCode=AED|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 3, "CountryCode=AF|CountryName=Afghanistan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 4, "CountryCode=AG|CountryName=Antigua and Barbuda|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 5, "CountryCode=AI|CountryName=Anguilla|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 6, "CountryCode=AL|CountryName=Albania|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 7, "CountryCode=AM|CountryName=Armenia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 8, "CountryCode=AO|CountryName=Angola|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 9, "CountryCode=AQ|CountryName=Antarctica|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 10, "CountryCode=AR|CountryName=Argentina|DefaultCurrencyCode=ARS|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 11, "CountryCode=AS|CountryName=American Samoa|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 12, "CountryCode=AT|CountryName=Austria|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 13, "CountryCode=AU|CountryName=Australia|DefaultCurrencyCode=AUD|PhonePrefix=+61").
  pbIgnored = pbDomain("Country", 14, "CountryCode=AW|CountryName=Aruba|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 15, "CountryCode=AX|CountryName=Aland Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 16, "CountryCode=AZ|CountryName=Azerbaijan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 17, "CountryCode=BA|CountryName=Bosnia and Herzegovina|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 18, "CountryCode=BB|CountryName=Barbados|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 19, "CountryCode=BD|CountryName=Bangladesh|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 20, "CountryCode=BE|CountryName=Belgium|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 21, "CountryCode=BF|CountryName=Burkina Faso|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 22, "CountryCode=BG|CountryName=Bulgaria|DefaultCurrencyCode=BGN|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 23, "CountryCode=BH|CountryName=Bahrain|DefaultCurrencyCode=BHD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 24, "CountryCode=BI|CountryName=Burundi|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 25, "CountryCode=BJ|CountryName=Benin|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 26, "CountryCode=BL|CountryName=Saint Barthelemy|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 27, "CountryCode=BM|CountryName=Bermuda|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 28, "CountryCode=BN|CountryName=Brunei Darussalam|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 29, "CountryCode=BO|CountryName=Bolivia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 30, "CountryCode=BQ|CountryName=Bonaire, Sint Eustatius and Saba|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 31, "CountryCode=BR|CountryName=Brazil|DefaultCurrencyCode=BRL|PhonePrefix=+55").
  pbIgnored = pbDomain("Country", 32, "CountryCode=BS|CountryName=Bahamas|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 33, "CountryCode=BT|CountryName=Bhutan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 34, "CountryCode=BV|CountryName=Bouvet Island|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 35, "CountryCode=BW|CountryName=Botswana|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 36, "CountryCode=BY|CountryName=Belarus|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 37, "CountryCode=BZ|CountryName=Belize|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 38, "CountryCode=CA|CountryName=Canada|DefaultCurrencyCode=CAD|PhonePrefix=+1").
  pbIgnored = pbDomain("Country", 39, "CountryCode=CC|CountryName=Cocos (Keeling) Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 40, "CountryCode=CD|CountryName=Congo, Democratic Republic of the|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 41, "CountryCode=CF|CountryName=Central African Republic|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 42, "CountryCode=CG|CountryName=Congo|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 43, "CountryCode=CH|CountryName=Switzerland|DefaultCurrencyCode=CHF|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 44, "CountryCode=CI|CountryName=Cote d'Ivoire|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 45, "CountryCode=CK|CountryName=Cook Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 46, "CountryCode=CL|CountryName=Chile|DefaultCurrencyCode=CLP|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 47, "CountryCode=CM|CountryName=Cameroon|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 48, "CountryCode=CN|CountryName=China|DefaultCurrencyCode=CNY|PhonePrefix=+86").
  pbIgnored = pbDomain("Country", 49, "CountryCode=CO|CountryName=Colombia|DefaultCurrencyCode=COP|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 50, "CountryCode=CR|CountryName=Costa Rica|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 51, "CountryCode=CU|CountryName=Cuba|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 52, "CountryCode=CV|CountryName=Cabo Verde|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 53, "CountryCode=CW|CountryName=Curacao|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 54, "CountryCode=CX|CountryName=Christmas Island|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 55, "CountryCode=CY|CountryName=Cyprus|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 56, "CountryCode=CZ|CountryName=Czechia|DefaultCurrencyCode=CZK|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 57, "CountryCode=DE|CountryName=Germany|DefaultCurrencyCode=EUR|PhonePrefix=+49").
  pbIgnored = pbDomain("Country", 58, "CountryCode=DJ|CountryName=Djibouti|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 59, "CountryCode=DK|CountryName=Denmark|DefaultCurrencyCode=DKK|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 60, "CountryCode=DM|CountryName=Dominica|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 61, "CountryCode=DO|CountryName=Dominican Republic|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 62, "CountryCode=DZ|CountryName=Algeria|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 63, "CountryCode=EC|CountryName=Ecuador|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 64, "CountryCode=EE|CountryName=Estonia|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 65, "CountryCode=EG|CountryName=Egypt|DefaultCurrencyCode=EGP|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 66, "CountryCode=EH|CountryName=Western Sahara|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 67, "CountryCode=ER|CountryName=Eritrea|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 68, "CountryCode=ES|CountryName=Spain|DefaultCurrencyCode=EUR|PhonePrefix=+34").
  pbIgnored = pbDomain("Country", 69, "CountryCode=ET|CountryName=Ethiopia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 70, "CountryCode=FI|CountryName=Finland|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 71, "CountryCode=FJ|CountryName=Fiji|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 72, "CountryCode=FK|CountryName=Falkland Islands (Malvinas)|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 73, "CountryCode=FM|CountryName=Micronesia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 74, "CountryCode=FO|CountryName=Faroe Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 75, "CountryCode=FR|CountryName=France|DefaultCurrencyCode=EUR|PhonePrefix=+33").
  pbIgnored = pbDomain("Country", 76, "CountryCode=GA|CountryName=Gabon|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 77, "CountryCode=GB|CountryName=United Kingdom|DefaultCurrencyCode=GBP|PhonePrefix=+44").
  pbIgnored = pbDomain("Country", 78, "CountryCode=GD|CountryName=Grenada|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 79, "CountryCode=GE|CountryName=Georgia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 80, "CountryCode=GF|CountryName=French Guiana|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 81, "CountryCode=GG|CountryName=Guernsey|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 82, "CountryCode=GH|CountryName=Ghana|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 83, "CountryCode=GI|CountryName=Gibraltar|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 84, "CountryCode=GL|CountryName=Greenland|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 85, "CountryCode=GM|CountryName=Gambia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 86, "CountryCode=GN|CountryName=Guinea|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 87, "CountryCode=GP|CountryName=Guadeloupe|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 88, "CountryCode=GQ|CountryName=Equatorial Guinea|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 89, "CountryCode=GR|CountryName=Greece|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 90, "CountryCode=GS|CountryName=South Georgia and the South Sandwich Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 91, "CountryCode=GT|CountryName=Guatemala|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 92, "CountryCode=GU|CountryName=Guam|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 93, "CountryCode=GW|CountryName=Guinea-Bissau|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 94, "CountryCode=GY|CountryName=Guyana|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 95, "CountryCode=HK|CountryName=Hong Kong|DefaultCurrencyCode=HKD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 96, "CountryCode=HM|CountryName=Heard Island and McDonald Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 97, "CountryCode=HN|CountryName=Honduras|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 98, "CountryCode=HR|CountryName=Croatia|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 99, "CountryCode=HT|CountryName=Haiti|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 100, "CountryCode=HU|CountryName=Hungary|DefaultCurrencyCode=HUF|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 101, "CountryCode=ID|CountryName=Indonesia|DefaultCurrencyCode=IDR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 102, "CountryCode=IE|CountryName=Ireland|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 103, "CountryCode=IL|CountryName=Israel|DefaultCurrencyCode=ILS|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 104, "CountryCode=IM|CountryName=Isle of Man|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 105, "CountryCode=IN|CountryName=India|DefaultCurrencyCode=INR|PhonePrefix=+91").
  pbIgnored = pbDomain("Country", 106, "CountryCode=IO|CountryName=British Indian Ocean Territory|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 107, "CountryCode=IQ|CountryName=Iraq|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 108, "CountryCode=IR|CountryName=Iran|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 109, "CountryCode=IS|CountryName=Iceland|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 110, "CountryCode=IT|CountryName=Italy|DefaultCurrencyCode=EUR|PhonePrefix=+39").
  pbIgnored = pbDomain("Country", 111, "CountryCode=JE|CountryName=Jersey|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 112, "CountryCode=JM|CountryName=Jamaica|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 113, "CountryCode=JO|CountryName=Jordan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 114, "CountryCode=JP|CountryName=Japan|DefaultCurrencyCode=JPY|PhonePrefix=+81").
  pbIgnored = pbDomain("Country", 115, "CountryCode=KE|CountryName=Kenya|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 116, "CountryCode=KG|CountryName=Kyrgyzstan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 117, "CountryCode=KH|CountryName=Cambodia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 118, "CountryCode=KI|CountryName=Kiribati|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 119, "CountryCode=KM|CountryName=Comoros|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 120, "CountryCode=KN|CountryName=Saint Kitts and Nevis|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 121, "CountryCode=KP|CountryName=North Korea|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 122, "CountryCode=KR|CountryName=South Korea|DefaultCurrencyCode=KRW|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 123, "CountryCode=KW|CountryName=Kuwait|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 124, "CountryCode=KY|CountryName=Cayman Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 125, "CountryCode=KZ|CountryName=Kazakhstan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 126, "CountryCode=LA|CountryName=Lao People's Democratic Republic|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 127, "CountryCode=LB|CountryName=Lebanon|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 128, "CountryCode=LC|CountryName=Saint Lucia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 129, "CountryCode=LI|CountryName=Liechtenstein|DefaultCurrencyCode=CHF|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 130, "CountryCode=LK|CountryName=Sri Lanka|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 131, "CountryCode=LR|CountryName=Liberia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 132, "CountryCode=LS|CountryName=Lesotho|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 133, "CountryCode=LT|CountryName=Lithuania|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 134, "CountryCode=LU|CountryName=Luxembourg|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 135, "CountryCode=LV|CountryName=Latvia|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 136, "CountryCode=LY|CountryName=Libya|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 137, "CountryCode=MA|CountryName=Morocco|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 138, "CountryCode=MC|CountryName=Monaco|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 139, "CountryCode=MD|CountryName=Moldova|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 140, "CountryCode=ME|CountryName=Montenegro|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 141, "CountryCode=MF|CountryName=Saint Martin (French part)|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 142, "CountryCode=MG|CountryName=Madagascar|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 143, "CountryCode=MH|CountryName=Marshall Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 144, "CountryCode=MK|CountryName=North Macedonia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 145, "CountryCode=ML|CountryName=Mali|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 146, "CountryCode=MM|CountryName=Myanmar|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 147, "CountryCode=MN|CountryName=Mongolia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 148, "CountryCode=MO|CountryName=Macao|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 149, "CountryCode=MP|CountryName=Northern Mariana Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 150, "CountryCode=MQ|CountryName=Martinique|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 151, "CountryCode=MR|CountryName=Mauritania|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 152, "CountryCode=MS|CountryName=Montserrat|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 153, "CountryCode=MT|CountryName=Malta|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 154, "CountryCode=MU|CountryName=Mauritius|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 155, "CountryCode=MV|CountryName=Maldives|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 156, "CountryCode=MW|CountryName=Malawi|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 157, "CountryCode=MX|CountryName=Mexico|DefaultCurrencyCode=MXN|PhonePrefix=+52").
  pbIgnored = pbDomain("Country", 158, "CountryCode=MY|CountryName=Malaysia|DefaultCurrencyCode=MYR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 159, "CountryCode=MZ|CountryName=Mozambique|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 160, "CountryCode=NA|CountryName=Namibia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 161, "CountryCode=NC|CountryName=New Caledonia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 162, "CountryCode=NE|CountryName=Niger|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 163, "CountryCode=NF|CountryName=Norfolk Island|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 164, "CountryCode=NG|CountryName=Nigeria|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 165, "CountryCode=NI|CountryName=Nicaragua|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 166, "CountryCode=NL|CountryName=Netherlands|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 167, "CountryCode=NO|CountryName=Norway|DefaultCurrencyCode=NOK|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 168, "CountryCode=NP|CountryName=Nepal|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 169, "CountryCode=NR|CountryName=Nauru|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 170, "CountryCode=NU|CountryName=Niue|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 171, "CountryCode=NZ|CountryName=New Zealand|DefaultCurrencyCode=NZD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 172, "CountryCode=OM|CountryName=Oman|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 173, "CountryCode=PA|CountryName=Panama|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 174, "CountryCode=PE|CountryName=Peru|DefaultCurrencyCode=PEN|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 175, "CountryCode=PF|CountryName=French Polynesia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 176, "CountryCode=PG|CountryName=Papua New Guinea|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 177, "CountryCode=PH|CountryName=Philippines|DefaultCurrencyCode=PHP|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 178, "CountryCode=PK|CountryName=Pakistan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 179, "CountryCode=PL|CountryName=Poland|DefaultCurrencyCode=PLN|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 180, "CountryCode=PM|CountryName=Saint Pierre and Miquelon|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 181, "CountryCode=PN|CountryName=Pitcairn|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 182, "CountryCode=PR|CountryName=Puerto Rico|DefaultCurrencyCode=USD|PhonePrefix=+1").
  pbIgnored = pbDomain("Country", 183, "CountryCode=PS|CountryName=Palestine|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 184, "CountryCode=PT|CountryName=Portugal|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 185, "CountryCode=PW|CountryName=Palau|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 186, "CountryCode=PY|CountryName=Paraguay|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 187, "CountryCode=QA|CountryName=Qatar|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 188, "CountryCode=RE|CountryName=Reunion|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 189, "CountryCode=RO|CountryName=Romania|DefaultCurrencyCode=RON|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 190, "CountryCode=RS|CountryName=Serbia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 191, "CountryCode=RU|CountryName=Russian Federation|DefaultCurrencyCode=RUB|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 192, "CountryCode=RW|CountryName=Rwanda|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 193, "CountryCode=SA|CountryName=Saudi Arabia|DefaultCurrencyCode=SAR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 194, "CountryCode=SB|CountryName=Solomon Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 195, "CountryCode=SC|CountryName=Seychelles|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 196, "CountryCode=SD|CountryName=Sudan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 197, "CountryCode=SE|CountryName=Sweden|DefaultCurrencyCode=SEK|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 198, "CountryCode=SG|CountryName=Singapore|DefaultCurrencyCode=SGD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 199, "CountryCode=SH|CountryName=Saint Helena, Ascension and Tristan da Cunha|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 200, "CountryCode=SI|CountryName=Slovenia|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 201, "CountryCode=SJ|CountryName=Svalbard and Jan Mayen|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 202, "CountryCode=SK|CountryName=Slovakia|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 203, "CountryCode=SL|CountryName=Sierra Leone|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 204, "CountryCode=SM|CountryName=San Marino|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 205, "CountryCode=SN|CountryName=Senegal|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 206, "CountryCode=SO|CountryName=Somalia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 207, "CountryCode=SR|CountryName=Suriname|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 208, "CountryCode=SS|CountryName=South Sudan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 209, "CountryCode=ST|CountryName=Sao Tome and Principe|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 210, "CountryCode=SV|CountryName=El Salvador|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 211, "CountryCode=SX|CountryName=Sint Maarten (Dutch part)|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 212, "CountryCode=SY|CountryName=Syrian Arab Republic|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 213, "CountryCode=SZ|CountryName=Eswatini|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 214, "CountryCode=TC|CountryName=Turks and Caicos Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 215, "CountryCode=TD|CountryName=Chad|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 216, "CountryCode=TF|CountryName=French Southern Territories|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 217, "CountryCode=TG|CountryName=Togo|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 218, "CountryCode=TH|CountryName=Thailand|DefaultCurrencyCode=THB|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 219, "CountryCode=TJ|CountryName=Tajikistan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 220, "CountryCode=TK|CountryName=Tokelau|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 221, "CountryCode=TL|CountryName=Timor-Leste|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 222, "CountryCode=TM|CountryName=Turkmenistan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 223, "CountryCode=TN|CountryName=Tunisia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 224, "CountryCode=TO|CountryName=Tonga|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 225, "CountryCode=TR|CountryName=Turkiye|DefaultCurrencyCode=TRY|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 226, "CountryCode=TT|CountryName=Trinidad and Tobago|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 227, "CountryCode=TV|CountryName=Tuvalu|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 228, "CountryCode=TW|CountryName=Taiwan|DefaultCurrencyCode=TWD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 229, "CountryCode=TZ|CountryName=Tanzania|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 230, "CountryCode=UA|CountryName=Ukraine|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 231, "CountryCode=UG|CountryName=Uganda|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 232, "CountryCode=UM|CountryName=United States Minor Outlying Islands|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 233, "CountryCode=US|CountryName=United States|DefaultCurrencyCode=USD|PhonePrefix=+1").
  pbIgnored = pbDomain("Country", 234, "CountryCode=UY|CountryName=Uruguay|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 235, "CountryCode=UZ|CountryName=Uzbekistan|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 236, "CountryCode=VA|CountryName=Holy See|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 237, "CountryCode=VC|CountryName=Saint Vincent and the Grenadines|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 238, "CountryCode=VE|CountryName=Venezuela|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 239, "CountryCode=VG|CountryName=Virgin Islands (British)|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 240, "CountryCode=VI|CountryName=Virgin Islands (U.S.)|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 241, "CountryCode=VN|CountryName=Viet Nam|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 242, "CountryCode=VU|CountryName=Vanuatu|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 243, "CountryCode=WF|CountryName=Wallis and Futuna|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 244, "CountryCode=WS|CountryName=Samoa|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 245, "CountryCode=XK|CountryName=Kosovo|DefaultCurrencyCode=EUR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 246, "CountryCode=YE|CountryName=Yemen|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 247, "CountryCode=YT|CountryName=Mayotte|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 248, "CountryCode=ZA|CountryName=South Africa|DefaultCurrencyCode=ZAR|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 249, "CountryCode=ZM|CountryName=Zambia|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("Country", 250, "CountryCode=ZW|CountryName=Zimbabwe|DefaultCurrencyCode=USD|PhonePrefix=+20").
  pbIgnored = pbDomain("AccountType", 1, "AccountTypeCode=CHKBASIC|AccountTypeName=Basic Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.01|MinimumBalance=0|MonthlyFee=5|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 2, "AccountTypeCode=CHKFREE|AccountTypeName=Free Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0|MinimumBalance=0|MonthlyFee=0|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 3, "AccountTypeCode=CHKPLUS|AccountTypeName=Checking Plus|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.05|MinimumBalance=1500|MonthlyFee=12|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 4, "AccountTypeCode=CHKPREM|AccountTypeName=Premier Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.1|MinimumBalance=10000|MonthlyFee=25|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 5, "AccountTypeCode=CHKSTUD|AccountTypeName=Student Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0|MinimumBalance=0|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 6, "AccountTypeCode=CHKSENR|AccountTypeName=Senior Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.05|MinimumBalance=0|MonthlyFee=0|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 7, "AccountTypeCode=CHKBUS|AccountTypeName=Business Checking|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.02|MinimumBalance=2500|MonthlyFee=15|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 8, "AccountTypeCode=CHKBUSPL|AccountTypeName=Business Checking Plus|Category=CHECKING|TermMonths=0|CurrentInterestRate=0.08|MinimumBalance=25000|MonthlyFee=30|OverdraftAllowed=true").
  pbIgnored = pbDomain("AccountType", 9, "AccountTypeCode=SAVBASIC|AccountTypeName=Basic Savings|Category=SAVINGS|TermMonths=0|CurrentInterestRate=0.25|MinimumBalance=300|MonthlyFee=3|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 10, "AccountTypeCode=SAVHIYLD|AccountTypeName=High-Yield Savings|Category=SAVINGS|TermMonths=0|CurrentInterestRate=3.8|MinimumBalance=1000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 11, "AccountTypeCode=SAVKIDS|AccountTypeName=Kids Savings|Category=SAVINGS|TermMonths=0|CurrentInterestRate=1|MinimumBalance=0|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 12, "AccountTypeCode=SAVGOAL|AccountTypeName=Goal Savings|Category=SAVINGS|TermMonths=0|CurrentInterestRate=2.5|MinimumBalance=100|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 13, "AccountTypeCode=SAVBUS|AccountTypeName=Business Savings|Category=SAVINGS|TermMonths=0|CurrentInterestRate=1.5|MinimumBalance=5000|MonthlyFee=5|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 14, "AccountTypeCode=SAVHOL|AccountTypeName=Holiday Club|Category=SAVINGS|TermMonths=0|CurrentInterestRate=0.5|MinimumBalance=0|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 15, "AccountTypeCode=MMSTD|AccountTypeName=Money Market|Category=MONEYMARKET|TermMonths=0|CurrentInterestRate=3.1|MinimumBalance=2500|MonthlyFee=10|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 16, "AccountTypeCode=MMPREM|AccountTypeName=Premier Money Market|Category=MONEYMARKET|TermMonths=0|CurrentInterestRate=4.05|MinimumBalance=25000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 17, "AccountTypeCode=MMBUS|AccountTypeName=Business Money Market|Category=MONEYMARKET|TermMonths=0|CurrentInterestRate=3.6|MinimumBalance=10000|MonthlyFee=15|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 18, "AccountTypeCode=CD3M|AccountTypeName=3-Month CD|Category=CD|TermMonths=3|CurrentInterestRate=3.5|MinimumBalance=500|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 19, "AccountTypeCode=CD6M|AccountTypeName=6-Month CD|Category=CD|TermMonths=6|CurrentInterestRate=4.1|MinimumBalance=500|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 20, "AccountTypeCode=CD12M|AccountTypeName=12-Month CD|Category=CD|TermMonths=12|CurrentInterestRate=4.4|MinimumBalance=500|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 21, "AccountTypeCode=CD18M|AccountTypeName=18-Month CD|Category=CD|TermMonths=18|CurrentInterestRate=4.25|MinimumBalance=1000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 22, "AccountTypeCode=CD24M|AccountTypeName=24-Month CD|Category=CD|TermMonths=24|CurrentInterestRate=4|MinimumBalance=1000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 23, "AccountTypeCode=CD36M|AccountTypeName=36-Month CD|Category=CD|TermMonths=36|CurrentInterestRate=3.85|MinimumBalance=1000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("AccountType", 24, "AccountTypeCode=CD60M|AccountTypeName=60-Month CD|Category=CD|TermMonths=60|CurrentInterestRate=3.7|MinimumBalance=1000|MonthlyFee=0|OverdraftAllowed=false").
  pbIgnored = pbDomain("TransactionType", 1, "TransactionTypeCode=POS|Description=Point-of-sale purchase|Direction=D|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 2, "TransactionTypeCode=POSCB|Description=Point-of-sale purchase with cash back|Direction=D|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 3, "TransactionTypeCode=ECOM|Description=Online card purchase|Direction=D|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 4, "TransactionTypeCode=CONTLS|Description=Contactless card purchase|Direction=D|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 5, "TransactionTypeCode=RECUR|Description=Recurring card payment|Direction=D|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 6, "TransactionTypeCode=ATMWD|Description=ATM withdrawal|Direction=D|Channel=ATM|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 7, "TransactionTypeCode=ATMWDF|Description=ATM withdrawal, foreign|Direction=D|Channel=ATM|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 8, "TransactionTypeCode=ATMXFR|Description=ATM transfer out|Direction=D|Channel=ATM|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 9, "TransactionTypeCode=ACHDB|Description=ACH debit|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 10, "TransactionTypeCode=ACHBILL|Description=ACH bill payment|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 11, "TransactionTypeCode=ACHLOAN|Description=ACH loan payment|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 12, "TransactionTypeCode=ACHTAX|Description=ACH tax payment|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 13, "TransactionTypeCode=ACHINS|Description=ACH insurance premium|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 14, "TransactionTypeCode=ACHUTIL|Description=ACH utility payment|Direction=D|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 15, "TransactionTypeCode=WIREOUT|Description=Outgoing wire|Direction=D|Channel=WIRE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 16, "TransactionTypeCode=WIREINT|Description=Outgoing international wire|Direction=D|Channel=WIRE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 17, "TransactionTypeCode=XFER|Description=Transfer to another account|Direction=D|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 18, "TransactionTypeCode=LOANPMT|Description=Loan payment|Direction=D|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 19, "TransactionTypeCode=CHKPAID|Description=Check paid|Direction=D|Channel=BRANCH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 20, "TransactionTypeCode=CASHWD|Description=Teller cash withdrawal|Direction=D|Channel=BRANCH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 21, "TransactionTypeCode=BILLPAY|Description=Online bill payment|Direction=D|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 22, "TransactionTypeCode=P2POUT|Description=Person-to-person payment sent|Direction=D|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 23, "TransactionTypeCode=FEEMNT|Description=Monthly maintenance fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 24, "TransactionTypeCode=FEEOD|Description=Overdraft fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 25, "TransactionTypeCode=FEENSF|Description=Insufficient funds fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 26, "TransactionTypeCode=FEEATM|Description=ATM fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 27, "TransactionTypeCode=FEEWIRE|Description=Wire transfer fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 28, "TransactionTypeCode=FEEFX|Description=Foreign transaction fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 29, "TransactionTypeCode=FEESTMT|Description=Paper statement fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 30, "TransactionTypeCode=FEESTOP|Description=Stop payment fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 31, "TransactionTypeCode=FEECARD|Description=Card replacement fee|Direction=D|Channel=INTERNAL|IsFee=true").
  pbIgnored = pbDomain("TransactionType", 32, "TransactionTypeCode=DBADJ|Description=Debit adjustment|Direction=D|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 33, "TransactionTypeCode=PAYROLL|Description=Payroll direct deposit|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 34, "TransactionTypeCode=ACHCR|Description=ACH credit|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 35, "TransactionTypeCode=ACHGOV|Description=Government benefit|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 36, "TransactionTypeCode=ACHTAXR|Description=Tax refund|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 37, "TransactionTypeCode=ACHPENS|Description=Pension payment|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 38, "TransactionTypeCode=WIREIN|Description=Incoming wire|Direction=C|Channel=WIRE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 39, "TransactionTypeCode=WIREINTI|Description=Incoming international wire|Direction=C|Channel=WIRE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 40, "TransactionTypeCode=XFERIN|Description=Transfer from another account|Direction=C|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 41, "TransactionTypeCode=DEPCASH|Description=Cash deposit|Direction=C|Channel=BRANCH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 42, "TransactionTypeCode=DEPCHK|Description=Check deposit|Direction=C|Channel=BRANCH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 43, "TransactionTypeCode=DEPMOB|Description=Mobile check deposit|Direction=C|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 44, "TransactionTypeCode=DEPATM|Description=ATM deposit|Direction=C|Channel=ATM|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 45, "TransactionTypeCode=INTPAID|Description=Interest paid|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 46, "TransactionTypeCode=REFUND|Description=Merchant refund|Direction=C|Channel=POS|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 47, "TransactionTypeCode=P2PIN|Description=Person-to-person payment received|Direction=C|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 48, "TransactionTypeCode=REVFEE|Description=Fee reversal|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 49, "TransactionTypeCode=CRADJ|Description=Credit adjustment|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 50, "TransactionTypeCode=DIVID|Description=Dividend credit|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 51, "TransactionTypeCode=RWDS|Description=Rewards redemption|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 52, "TransactionTypeCode=CBACK|Description=Chargeback credit|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 53, "TransactionTypeCode=LOANDSB|Description=Loan disbursement|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 54, "TransactionTypeCode=CDMAT|Description=CD maturity credit|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 55, "TransactionTypeCode=ZELLEIN|Description=Instant payment received|Direction=C|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 56, "TransactionTypeCode=VENMOIN|Description=Wallet transfer in|Direction=C|Channel=ONLINE|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 57, "TransactionTypeCode=ACHSAL|Description=Salary advance|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 58, "TransactionTypeCode=INSCLM|Description=Insurance claim payment|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 59, "TransactionTypeCode=GRANT|Description=Grant payment|Direction=C|Channel=ACH|IsFee=false").
  pbIgnored = pbDomain("TransactionType", 60, "TransactionTypeCode=MISCCR|Description=Miscellaneous credit|Direction=C|Channel=INTERNAL|IsFee=false").
  pbIgnored = pbDomain("MerchantCategory", 1, "CategoryGroup=Airlines|minimumCode=3000|maximumCode=3299").
  pbIgnored = pbDomain("MerchantCategory", 2, "CategoryGroup=Car Rental|minimumCode=3351|maximumCode=3441").
  pbIgnored = pbDomain("MerchantCategory", 3, "CategoryGroup=Lodging|minimumCode=3501|maximumCode=3999").
  pbIgnored = pbDomain("MerchantCategory", 4, "CategoryGroup=Transportation|minimumCode=4000|maximumCode=4799").
  pbIgnored = pbDomain("MerchantCategory", 5, "CategoryGroup=Utilities|minimumCode=4800|maximumCode=4999").
  pbIgnored = pbDomain("MerchantCategory", 6, "CategoryGroup=Wholesale|minimumCode=5000|maximumCode=5199").
  pbIgnored = pbDomain("MerchantCategory", 7, "CategoryGroup=Grocery|minimumCode=5200|maximumCode=5499").
  pbIgnored = pbDomain("MerchantCategory", 8, "CategoryGroup=Automotive|minimumCode=5500|maximumCode=5599").
  pbIgnored = pbDomain("MerchantCategory", 9, "CategoryGroup=Apparel|minimumCode=5600|maximumCode=5699").
  pbIgnored = pbDomain("MerchantCategory", 10, "CategoryGroup=Home Furnishing|minimumCode=5700|maximumCode=5799").
  pbIgnored = pbDomain("MerchantCategory", 11, "CategoryGroup=Restaurants|minimumCode=5800|maximumCode=5899").
  pbIgnored = pbDomain("MerchantCategory", 12, "CategoryGroup=Retail|minimumCode=5900|maximumCode=5999").
  pbIgnored = pbDomain("MerchantCategory", 13, "CategoryGroup=Financial|minimumCode=6000|maximumCode=6399").
  pbIgnored = pbDomain("MerchantCategory", 14, "CategoryGroup=Personal Services|minimumCode=7000|maximumCode=7299").
  pbIgnored = pbDomain("MerchantCategory", 15, "CategoryGroup=Business Services|minimumCode=7300|maximumCode=7399").
  pbIgnored = pbDomain("MerchantCategory", 16, "CategoryGroup=Repair Services|minimumCode=7500|maximumCode=7699").
  pbIgnored = pbDomain("MerchantCategory", 17, "CategoryGroup=Entertainment|minimumCode=7800|maximumCode=7999").
  pbIgnored = pbDomain("MerchantCategory", 18, "CategoryGroup=Medical|minimumCode=8000|maximumCode=8099").
  pbIgnored = pbDomain("MerchantCategory", 19, "CategoryGroup=Professional Services|minimumCode=8100|maximumCode=8999").
  pbIgnored = pbDomain("MerchantCategory", 20, "CategoryGroup=Government|minimumCode=9000|maximumCode=9999").
  RETURN TRUE.
END FUNCTION.
