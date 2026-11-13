#!/bin/sh
# Fires unless evidence.yml gives every criterion a file the steps left in .away/out/.
# It reads the few line shapes prove.md lists and fires on any other, so nothing it can't read passes.
out=${AWAYWORK_OUT_DIR:?not run as a gate}
manifest=$out/evidence.yml
[ -f "$manifest" ] && [ ! -L "$manifest" ] || { echo "no evidence.yml"; exit 1; }

# "F<tab><n><tab><file>" per file to look for, "P<tab><problem>" per problem; it stops at the first line it can't read.
found=$(LC_ALL=C awk '
  function bad(why) { print "P\tevidence.yml line " NR ": " why; failed = 1; exit }
  function unquote(s) {
    gsub(/^[ \t]+|[ \t]+$/, "", s)
    if (s ~ /^".*"$/ || s ~ /^\047.*\047$/) s = substr(s, 2, length(s) - 2)
    return s
  }
  function plain(s,   parts, count, i) {
    if (s !~ /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/ || index(s, "..")) return 0
    count = split(s, parts, "/")
    for (i = 1; i <= count; i++) if (parts[i] == ".") return 0
    return 1
  }
  function file(s,   low) {
    s = unquote(s)
    if (s == "") bad("an empty name in files")
    files++
    low = tolower(s)
    if (!plain(s)) print "P\tcriterion " n ": " s " isn\047t a plain path in .away/out/"
    else if (low == "evidence.yml" || low == "report.md" || low == "summary.md")
      print "P\tcriterion " n ": " s " is the step\047s own file, not proof"
    else print "F\t" n "\t" s
  }
  function close_criterion() { if (n && !files) print "P\tno file for criterion " n }
  /^[ \t]*$/ || /^ *#/ { next }
  !started { if ($0 !~ /^criteria:[ \t]*$/) bad("expected \"criteria:\""); started = 1; next }
  {
    match($0, /^ */); indent = RLENGTH; rest = substr($0, indent + 1)
    if (rest ~ /^- criterion: +[^ |>]/ && (!n || indent == depth)) {
      close_criterion(); depth = indent; n++; files = has_files = has_gap = block = 0; next
    }
    if (n && indent == depth + 2 && rest ~ /^gap: +[^ |>]/) {
      if (has_gap++) bad("criterion " n " already has a gap")
      block = 0; next
    }
    if (n && indent == depth + 2 && rest ~ /^files:/) {
      if (has_files++) bad("criterion " n " already has files")
      block = 0
      if (rest ~ /^files:[ \t]*$/) { block = 1; next }
      if (rest !~ /^files: *\[.*\][ \t]*$/) bad("files is a list on one line, or one name per line under it")
      sub(/^files: *\[/, "", rest); sub(/\][ \t]*$/, "", rest)
      if (index(rest, "[") || index(rest, "]")) bad("a bracket in files")
      if (rest ~ /^[ \t]*$/) next
      count = split(rest, listed, ","); for (i = 1; i <= count; i++) file(listed[i])
      next
    }
    if (block && indent >= depth + 2 && rest ~ /^- +[^ ]/) { sub(/^- +/, "", rest); file(rest); next }
    bad("not a criterion, files or gap line")
  }
  END { if (!failed) close_criterion() }
' "$manifest")
[ -n "$found" ] || { echo "evidence.yml lists no criterion"; exit 1; }

# A link at $1 under the out dir, or a linked folder above it.
linked() {
  path=$1
  while :; do
    [ -L "$out/$path" ] && return 0
    case $path in (*/*) path=${path%/*} ;; (*) return 1 ;; esac
  done
}

tab=$(printf '\t')
problems=$(printf '%s\n' "$found" | while IFS=$tab read -r kind rest; do
  [ "$kind" = F ] || { printf '%s\n' "$rest"; continue; }
  n=${rest%%"$tab"*} file=${rest#*"$tab"}
  if linked "$file"; then printf '%s\n' "criterion $n: $file is a link, or in a linked folder"
  elif [ ! -f "$out/$file" ] || [ ! -s "$out/$file" ]; then printf '%s\n' "criterion $n: $file is missing or empty"
  fi
done)
[ -z "$problems" ] || { printf '%s\n' "$problems"; exit 1; }
