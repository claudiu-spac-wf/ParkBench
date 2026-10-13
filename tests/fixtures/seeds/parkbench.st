# ParkBenchDB structure file - generated from schema/parkbench-schema.yaml by tools/gen_db_files.py.
# One variable extent per area; requires large-file support (enabled by db/build_db.*).
b .
d "Schema Area":6,32;1 .
d "PB_Ref_Data":7,64;8 .
d "PB_Master_Narrow":8,32;64 .
d "PB_Master_Std":9,16;64 .
d "PB_Master_Wide":10,8;64 .
d "PB_Txn_Debit":11,32;512 .
d "PB_Txn_CardAuth":12,64;512 .
d "PB_Txn_Audit":13,32;512 .
d "PB_Txn_Large":14,32;512 .
d "PB_Ref_Idx":15,64;8 .
d "PB_Master_Idx":16,64;64 .
d "PB_Txn_Idx":17,64;512 .
d "PB_Lob_Doc":18,8;512 .
d "PB_Lob_Stmt":19,8;512 .
d "PB_Lob_Text":20,8;512 .
