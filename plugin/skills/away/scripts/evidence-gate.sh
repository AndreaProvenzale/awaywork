#!/bin/sh
# Fires unless evidence.yml gives every criterion a file the steps left in .away/out/.
out=${AWAYWORK_OUT_DIR:?not run as a gate}
manifest=$out/evidence.yml
[ -f "$manifest" ] && [ ! -L "$manifest" ] || { echo "no evidence.yml"; exit 1; }

# One line per criterion and file, "<n><tab><file>", the file empty when a criterion names none.
pairs=$(awk '
  function clean(s) { gsub(/^[ \t"\047]+|[ \t"\047]+$/, "", s); return s }
  function file(s) { s = clean(s); if (s != "") { print n "\t" s; files++ } }
  function close_criterion() { if (n && !files) print n "\t" }
  /^ *- +criterion:/ { close_criterion(); n++; files = 0; block = 0; next }
  /^ *files: *\[/ {
    sub(/^ *files: *\[/, ""); sub(/\].*$/, "")
    count = split($0, listed, ","); for (i = 1; i <= count; i++) file(listed[i])
    block = 0; next
  }
  /^ *files: *$/ { block = 1; next }
  block && /^ *- / { sub(/^ *- +/, ""); file($0); next }
  { block = 0 }
  END { close_criterion() }
' "$manifest")
[ -n "$pairs" ] || { echo "evidence.yml lists no criterion"; exit 1; }

tab=$(printf '\t')
problems=$(printf '%s\n' "$pairs" | while IFS=$tab read -r n file; do
  case $file in
    ('') echo "no file for criterion $n" ;;
    (/* | *..*) echo "criterion $n: $file isn't a path in .away/out/" ;;
    (*) [ -f "$out/$file" ] && [ ! -L "$out/$file" ] && [ -s "$out/$file" ] ||
      echo "criterion $n: $file is missing or empty" ;;
  esac
done)
[ -z "$problems" ] || { echo "$problems"; exit 1; }
