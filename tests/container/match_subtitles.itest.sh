#!/usr/bin/env bash
# Integration test for scripts/match-subtitles.sh: builds scenario folders under a fresh mktemp
# directory, runs the script on them and checks the resulting file names and its report. Run it
# inside the tdarr-node container (see README "Tests"); it writes nothing outside that directory.
#
#   MSYS_NO_PATHCONV=1 docker cp scripts/match-subtitles.sh tdarr-node:/tmp/match-subtitles.sh
#   MSYS_NO_PATHCONV=1 docker cp tests/container/match_subtitles.itest.sh tdarr-node:/tmp/match_subtitles.itest.sh
#   MSYS_NO_PATHCONV=1 docker exec tdarr-node bash /tmp/match_subtitles.itest.sh /tmp/match-subtitles.sh
#   MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -f /tmp/match-subtitles.sh /tmp/match_subtitles.itest.sh
S="${1:?usage: match_subtitles.itest.sh <path to match-subtitles.sh>}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0

# check DIR FILE...: DIR holds exactly these files.
check() {
    local d="$1" got want
    shift
    got="$(cd "$T/$d" && ls -1 | sort)"
    want="$(printf '%s\n' "$@" | sort)"
    if [[ "$got" == "$want" ]]; then
        echo "PASS files in $d"
    else
        printf 'FAIL files in %s:\n%s\n' "$d" "$got"
        fail=1
    fi
}

# A: subtitle and sidecar already match a video named with empty parentheses. Nothing to do,
#    and not a conflict (the false CONFLICT seen on DAN DA DAN, 2026-11-09).
mkdir -p "$T/A" && touch "$T/A/Ep1 ().mkv" "$T/A/Ep1 ().en.srt" "$T/A/Ep1 ().nfo"
# B: the video gained a suffix; the subtitle and sidecar with empty parentheses follow it.
mkdir -p "$T/B" && touch "$T/B/Ep2 (Tdarr).mkv" "$T/B/Ep2 ().en.srt" "$T/B/Ep2 ().nfo"
# C: plain names, the video gained a suffix; language and tag parts are kept.
mkdir -p "$T/C" && touch "$T/C/Movie (Tdarr).mkv" "$T/C/Movie.en.forced.srt"
# D: a real conflict: both subtitle names exist, nothing is overwritten.
mkdir -p "$T/D" && touch "$T/D/Ep3 (Tdarr).mkv" "$T/D/Ep3 ().en.srt" "$T/D/Ep3 (Tdarr).en.srt"
# E: plain exact match: nothing to do.
mkdir -p "$T/E" && touch "$T/E/Show.mkv" "$T/E/Show.en.srt"

out="$(bash "$S" "$T" 2>&1)"
printf '%s\n' "$out" | sed 's/^/  | /'

check A "Ep1 ().mkv" "Ep1 ().en.srt" "Ep1 ().nfo"
check B "Ep2 (Tdarr).mkv" "Ep2 (Tdarr).en.srt" "Ep2 (Tdarr).nfo"
check C "Movie (Tdarr).mkv" "Movie (Tdarr).en.forced.srt"
check D "Ep3 (Tdarr).mkv" "Ep3 ().en.srt" "Ep3 (Tdarr).en.srt"
check E "Show.mkv" "Show.en.srt"

conflicts="$(printf '%s\n' "$out" | grep -c 'CONFLICT')"
if [[ "$conflicts" -eq 1 ]] && printf '%s\n' "$out" | grep -q 'CONFLICT.*Ep3 (Tdarr).en.srt'; then
    echo "PASS one CONFLICT, for D only"
else
    echo "FAIL expected one CONFLICT (D), got $conflicts"
    fail=1
fi
if printf '%s\n' "$out" | grep -q 'Renamed: 3  |  Skipped: 1  |  No video: 0  |  Ambiguous: 0'; then
    echo "PASS summary"
else
    echo "FAIL summary"
    fail=1
fi

if [[ "$fail" -eq 0 ]]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
