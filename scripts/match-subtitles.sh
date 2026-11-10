#!/usr/bin/env bash
#
# match-subtitles.sh
#
# Renames subtitle files to match their corresponding video files.
# Recursively searches for subtitle files and checks if a matching video file
# exists in the same directory. If the video has a suffix (e.g. ' (Tdarr)' or
# ' (ETHEL)') that the subtitle doesn't, the subtitle is renamed to match.
#
# Per-episode sidecar files (.nfo metadata, .jpg/.png thumbnails) are renamed
# the same way. Folder-level files (poster.jpg, season.nfo, ...) are ignored.
#
# Usage: match-subtitles.sh [-n|--dry-run] [-p|--prompt] [PATH]

# ── Constants ─────────────────────────────────────────────────────────────────

SUBTITLE_EXTS=(srt ass ssa vtt sub idx sup)
SUBTITLE_TAGS=(forced sdh hi cc default full foreign)
# ogm and divx are in the library (Great Teacher Onizuka, Doctor Who); the rest are common too.
VIDEO_EXTS=(mkv mp4 avi mov wmv m4v ts m2ts mts mpg mpeg flv webm ogm ogv divx xvid vob rm rmvb 3gp asf f4v mk3d)
# Sidecars named exactly like the video (no language/tag parts).
SIDECAR_EXTS=(nfo jpg jpeg png tbn)
# Folder-level metadata/artwork names (lowercase stem) that never belong to one video.
FOLDER_ASSET_RE='^(tvshow|movie|show|season|season[ -]?[0-9]+|season-specials|season-all|specials|poster|fanart|folder|banner|logo|clearlogo|clearart|landscape|background|backdrop|art|thumb|cover|discart)(-(poster|fanart|banner|thumb|landscape))?$'

# ── Functions ─────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS] [PATH]

Renames subtitle files (and per-episode .nfo/.jpg/.png/.tbn sidecars) to match
their corresponding video files.

Arguments:
  PATH            Root directory to search (default: current directory)

Options:
  -n, --dry-run   Show what would be renamed without making any changes
  -p, --prompt    Prompt for confirmation before each rename
  -h, --help      Show this help message

Examples:
  $(basename "$0") /media/movies --dry-run
  $(basename "$0") /media/movies --prompt
EOF
    exit 0
}

# Returns 0 if the first argument (lowercased) matches any of the remaining
# arguments (which are expected to already be lowercase).
in_array() {
    local needle="${1,,}"
    shift
    local item
    for item in "$@"; do
        [[ "$item" == "$needle" ]] && return 0
    done
    return 1
}

# Returns 0 for a subtitle language code (2-3 lowercase letters) or tag (forced, sdh, ...).
is_lang_or_tag() {
    in_array "$1" "${SUBTITLE_TAGS[@]}" || [[ "$1" =~ ^[a-z]{2,3}$ ]]
}

# Strips the multi-part subtitle extension to get the bare video-title portion,
# but does NOT remove trailing empty parentheses.
# e.g. "Movie ().en.forced.srt" -> "Movie ()"
get_subtitle_stem() {
    local filename="$1"
    local name="$filename"
    local ext

    # Sidecars carry no language/tag parts: strip only the extension, so a
    # title like "Ask.me" isn't mistaken for a ".me" language code.
    ext="${name##*.}"
    if in_array "$ext" "${SIDECAR_EXTS[@]}"; then
        printf '%s' "${name%.*}"
        return
    fi

    # Strip the primary subtitle extension
    if in_array "$ext" "${SUBTITLE_EXTS[@]}"; then
        name="${name%.*}"
    fi

    # Repeatedly strip trailing language codes and subtitle tags. A number part
    # (".1.en.srt", ".en.2.srt": a second subtitle in the same language) is
    # stripped too, but only next to a language/tag part, so a title ending in a
    # number ("Movie 2.5.srt") is kept.
    local stripped=false part left
    while [[ "$name" == *.* ]]; do
        ext="${name##*.}"
        if is_lang_or_tag "$ext"; then
            name="${name%.*}"
            stripped=true
        elif [[ "$ext" =~ ^[0-9]{1,2}$ ]]; then
            left="${name%.*}"
            part="${left##*.}"
            if $stripped || { [[ "$left" == *.* ]] && is_lang_or_tag "$part"; }; then
                name="$left"
            else
                break
            fi
        else
            break
        fi
    done

    printf '%s' "$name"
}

# Like get_subtitle_stem but also strips trailing empty parentheses.
# e.g. "Movie ().en.forced.srt" -> "Movie"
get_subtitle_basename() {
    local name
    name="$(get_subtitle_stem "$1")"

    # Strip trailing empty parentheses, e.g. "Movie Name ()" -> "Movie Name"
    # Capture group stops at last non-whitespace char, so trimming is implicit.
    if [[ "$name" =~ ^(.*[^[:space:]])[[:space:]]*\([[:space:]]*\)[[:space:]]*$ ]]; then
        name="${BASH_REMATCH[1]}"
    fi

    printf '%s' "$name"
}

# Prints the path of the first video file in $dir whose stem equals $stem.
find_video_file() {
    local dir="$1"
    local stem="$2"
    local ext candidate

    for ext in "${VIDEO_EXTS[@]}"; do
        candidate="$dir/$stem.$ext"
        if [[ -f "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

# Prints all video files in $dir whose stem starts with "$stem " (trailing space).
find_videos_with_suffix() {
    local dir="$1"
    local stem="$2"
    local file basename filestem fileext

    while IFS= read -r -d '' file; do
        basename="${file##*/}"
        fileext="${basename##*.}"
        filestem="${basename%.*}"
        if in_array "$fileext" "${VIDEO_EXTS[@]}" && [[ "$filestem" == "$stem "* ]]; then
            printf '%s\n' "$file"
        fi
    done < <(find "$dir" -maxdepth 1 -type f -print0 2>/dev/null)
}

# ── Argument parsing ───────────────────────────────────────────────────────────

DRY_RUN=false
PROMPT=false
SEARCH_PATH="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--dry-run) DRY_RUN=true  ;;
        -p|--prompt)  PROMPT=true   ;;
        -h|--help)    usage          ;;
        -*) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
        *)  SEARCH_PATH="$1"         ;;
    esac
    shift
done

# ── Main ──────────────────────────────────────────────────────────────────────

SEARCH_PATH="$(realpath -- "$SEARCH_PATH")"

count_renamed=0
count_skipped=0
count_no_video=0
count_ambiguous=0

while IFS= read -r -d '' sub_file; do
    ext="${sub_file##*.}"
    in_array "$ext" "${SUBTITLE_EXTS[@]}" "${SIDECAR_EXTS[@]}" || continue

    dir="$(dirname "$sub_file")"
    filename="$(basename "$sub_file")"

    # Folder-level artwork/metadata (poster.jpg, season.nfo, ...) isn't per-video.
    if in_array "$ext" "${SIDECAR_EXTS[@]}"; then
        sidecar_stem="${filename%.*}"
        [[ "${sidecar_stem,,}" =~ $FOLDER_ASSET_RE ]] && continue
    fi
    stem="$(get_subtitle_stem "$filename")"
    base_name="$(get_subtitle_basename "$filename")"
    suffix="${filename:${#stem}}"        # e.g. ".en.forced.srt"

    # Exact video match → nothing to do. Check the stem as written ("Movie ()") as
    # well as without the empty parentheses ("Movie"): otherwise "Movie ().en.srt"
    # next to "Movie ().mkv" finds that video as a "suffixed" match, is renamed
    # to its own name, and is reported as a conflict.
    if find_video_file "$dir" "$base_name" > /dev/null 2>&1 \
        || find_video_file "$dir" "$stem" > /dev/null 2>&1; then
        continue
    fi

    # Look for a video with a suffix
    mapfile -t suffix_matches < <(find_videos_with_suffix "$dir" "$base_name")

    if [[ ${#suffix_matches[@]} -eq 0 ]]; then
        printf 'WARNING: [NO VIDEO]   %s\n' "$sub_file" >&2
        (( count_no_video++ , 1 ))
        continue
    fi

    if [[ ${#suffix_matches[@]} -gt 1 ]]; then
        match_names="$(printf '%s, ' "${suffix_matches[@]##*/}")"
        match_names="${match_names%, }"
        printf 'WARNING: [AMBIGUOUS]  %s\n' "$sub_file" >&2
        printf '         Candidates: %s\n' "$match_names" >&2
        (( count_ambiguous++ , 1 ))
        continue
    fi

    # Exactly one suffix match
    video_basename="${suffix_matches[0]##*/}"
    video_stem="${video_basename%.*}"
    new_name="$video_stem$suffix"
    target_path="$dir/$new_name"

    if $DRY_RUN; then
        printf '[DRY RUN] Would rename:\n  From: %s\n    To: %s\n  Dir : %s\n\n' \
            "$filename" "$new_name" "$dir"
        (( count_skipped++ , 1 ))
        continue
    fi

    if $PROMPT; then
        printf 'Rename?\n  From: %s\n    To: %s\n  Dir : %s\n' \
            "$filename" "$new_name" "$dir"
        read -r -p "  [Y/N] " answer
        if [[ ! "$answer" =~ ^[Yy] ]]; then
            echo "  Skipped."
            (( count_skipped++ , 1 ))
            continue
        fi
    fi

    if [[ -e "$target_path" ]]; then
        printf 'WARNING: [CONFLICT]   Target already exists, skipping: %s\n' "$new_name" >&2
        (( count_skipped++ , 1 ))
        continue
    fi

    mv -- "$sub_file" "$target_path"
    printf '[RENAMED]  %s > %s\n' "$filename" "$new_name"
    (( count_renamed++ , 1 ))

done < <(find "$SEARCH_PATH" -type f -print0)

# ── Summary ────────────────────────────────────────────────────────────────────

printf '\nDone. Renamed: %d  |  Skipped: %d  |  No video: %d  |  Ambiguous: %d\n' \
    "$count_renamed" "$count_skipped" "$count_no_video" "$count_ambiguous"
