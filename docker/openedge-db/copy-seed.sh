#!/bin/sh
# Copies a read-only on-disk seed database into the run-owned database directory.
# Usage: copy-seed.sh <seed-db-dir> <workdir> <db-name>
set -eu

seed_dir=$1
database_workdir=$2
db_name=$3

if [ ! -d "$seed_dir" ]; then
  echo "seed_missing" >&2
  exit 44
fi

restored_already=0
if [ -f "$database_workdir/.parkbench-seed-restored" ]; then
  restored_already=1
  if [ -n "${PARKBENCH_RUN_ID:-}" ]; then
    expected_identity=$(printf '%s\n' "$PARKBENCH_RUN_ID" "$db_name" "${PARKBENCH_SEED_IDENTITY:-}")
    if [ ! -f "$database_workdir/.parkbench-seed-identity" ] || [ "$(cat "$database_workdir/.parkbench-seed-identity")" != "$expected_identity" ]; then
      echo "database_bi_preparation_failed:restoration_identity_mismatch" >&2
      exit 54
    fi
  fi
fi

if [ "$restored_already" -eq 0 ] && find "$database_workdir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "run_database_volume_not_empty" >&2
  exit 47
fi

for required in "$db_name.db" "$db_name.st"; do
  if [ ! -f "$seed_dir/$required" ]; then
    echo "seed_database_files_missing:$required" >&2
    exit 50
  fi
done

# List every extent file the structure file implies (same rules as parseStructureFile in
# packages/contracts/src/seed.ts): area 6 is <db>.dN, other data areas are <db>_<area>.dN,
# and before-image/after-image/transaction extents are <db>.bN/.aN/.tN.
extents=$(awk -v db="$db_name" '
  { sub(/\r$/, ""); sub(/#.*/, "") }
  NF == 0 { next }
  {
    kind = $1
    area = (kind == "d") ? 6 : 0
    if (match($0, /":[0-9]+/)) area = substr($0, RSTART + 2, RLENGTH - 2) + 0
    path = $0
    if (index(path, "\"") > 0) { sub(/^[^"]*"[^"]*"[^ \t]*[ \t]+/, "", path) } else { sub(/^[a-z][ \t]+/, "", path) }
    split(path, fields, /[ \t]+/)
    key = kind ":" area
    count[key]++
    if (kind == "d") file = (area == 6) ? db ".d" count[key] : db "_" area ".d" count[key]
    else file = db "." kind count[key]
    print fields[1] "\t" file
  }
' "$seed_dir/$db_name.st")

if ! printf '%s\n' "$extents" | grep -q "	$db_name\.b[0-9]*$"; then
  echo "seed_database_files_missing:$db_name.b1" >&2
  exit 50
fi
old_ifs=$IFS
IFS='
'
for line in $extents; do
  extent_path=${line%%	*}
  extent_file=${line#*	}
  case "$extent_path" in
    /*|[A-Za-z]:*|*..*)
      echo "seed_database_invalid:absolute_extent_path:$extent_file" >&2
      exit 50 ;;
  esac
  if [ ! -f "$seed_dir/$extent_path/$extent_file" ]; then
    echo "seed_database_files_missing:$extent_file" >&2
    exit 50
  fi
done
IFS=$old_ifs

if [ "$restored_already" -eq 1 ]; then
  exit 0
fi

started=$(date +%s)
# Plain recursive copy: the seed bind mount may be owned by another user, so ownership is not preserved.
cp -R "$seed_dir/." "$database_workdir/"

# The control area records absolute extent paths from wherever the seed was loaded. Point
# every extent at this run's directory; the seed's own .st keeps its relative "." paths.
if command -v prostrct >/dev/null 2>&1; then
  repair_st="$database_workdir/.parkbench-repair.st"
  awk -v dir="$database_workdir" '
    { sub(/\r$/, "") }
    /^[bdat][ \t]/ {
      line = $0
      sub(/#.*/, "", line)
      if (index(line, "\"") > 0) {
        first = index(line, "\"")
        second = first + index(substr(line, first + 1), "\"")
        rest = substr(line, second + 1)
        match(rest, /^[^ \t]*/)
        head = substr(line, 1, second + RLENGTH)
        tail = substr(rest, RLENGTH + 1)
      } else {
        head = substr(line, 1, 1)
        tail = substr(line, 2)
      }
      count = split(tail, fields, /[ \t]+/)
      out = head " " dir
      for (i = 3; i <= count; i++) if (fields[i] != "") out = out " " fields[i]
      print out
      next
    }
    { print }
  ' "$database_workdir/$db_name.st" > "$repair_st"
  if ! (cd "$database_workdir" && prostrct repair "$db_name" "$repair_st" >/dev/null 2>&1); then
    echo "seed_structure_repair_failed" >&2
    exit 51
  fi
  rm -f "$repair_st"
fi
if [ -n "${PARKBENCH_RUN_ID:-}" ]; then
  printf '%s\n' "$PARKBENCH_RUN_ID" "$db_name" "${PARKBENCH_SEED_IDENTITY:-}" > "$database_workdir/.parkbench-seed-identity"
fi
: > "$database_workdir/.parkbench-seed-restored"
finished=$(date +%s)
echo "seed_copy_seconds=$((finished - started))"
