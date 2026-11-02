RUN prodict/load_df.p ("/fixture/schema.df").
IF ERROR-STATUS:ERROR THEN QUIT.
