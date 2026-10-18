#!/bin/zsh
# usage: scripts/live-benchmark/run_arm.sh <served-sha-prefix> <arm-label> <books-page>
#
# One arm of the shared live benchmark: five owner-style requests sent to the
# INSTALLED app (live model calls; never the test harness), each followed to
# its end, then a scorecard and a cleanup of what the arm built. Run the brain
# and judge you want first (switch_brain.py / set_role.py) and restore the
# owner's settings after. See README.md.
set -u
HERE=${0:A:h}
SHA=$1; ARM=$2; PAGE=$3
OUT=${LIVE_BENCHMARK_OUT:-$HOME/clementine-next/output/harness-coordination-watch/benchmark}/$(date -u +%Y-%m-%d)-$ARM
mkdir -p $OUT
python3 -I $HERE/wait_build.py $SHA || exit 1
run() {
  echo "=== [$ARM] $1"
  python3 -I $HERE/drive_turn.py $SHA "$3" > $OUT/$2.log 2>&1
  grep "DONE status" $OUT/$2.log; python3 -I $HERE/turn_report.py $OUT/$2.log
}
run "S1 Space synced to a local file" s1 "Build me a new Space called \"Shelf $ARM\" from ~/clem-fixtures/out/books.csv that stays in sync with the file whenever it changes: books grouped by star rating, cheapest first in each group."
run "S2 estimate over the data" s2 "Using ~/clem-fixtures/out/books.csv, which star rating gives the best value for money, and roughly how much would someone save buying the five cheapest five-star books instead of five at the average five-star price?"
run "S3 research report" s3 "Research the five most popular open-source Python web scraping libraries by GitHub stars. Compare them on stars, latest release date and license, and write the comparison as a short report to ~/clem-fixtures/out/scraping-libs-$ARM.md."
run "S4 Dana draft" s4 "Draft a reply to Dana about the booking page and save it to ~/clem-fixtures/out/dana-reply-$ARM.md."
run "S5 workflow, run once, left off" s5 "Set up a workflow that reads page $PAGE of https://books.toscrape.com and saves the title, price and star rating of every book on it to ~/clem-fixtures/out/page$PAGE-books-$ARM.csv, replacing the file. Run it once now to check it works, and leave it off — don't schedule it."
python3 -I $HERE/scorecard.py $OUT $ARM
# What the arm built is benchmark residue, not the owner's: archive the Space
# (recoverable) and delete the workflow after a backup.
python3 -I $HERE/cleanup.py $ARM
echo "ARM_DONE $OUT"
