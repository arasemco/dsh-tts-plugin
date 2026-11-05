#!/usr/bin/env bash
# =============================================================================
# next-version.sh — the next semver, from the commits since the last tag.
#
# Conventional Commits, highest wins:
#   type(scope)!: ... or a "BREAKING CHANGE" subject  → major
#   feat: ...                                         → minor
#   anything else                                     → patch
#   nothing new since the last tag                    → bump=none
#
# Prints GitHub Actions outputs:
#   version=<x.y.z>  bump=<major|minor|patch|none>  last=<previous tag>
# Run it by hand to see what the next release would be.
# =============================================================================
set -euo pipefail

last="$(git describe --tags --abbrev=0 2>/dev/null || echo 'v0.0.0')"
base="${last#v}"
base="${base%%-*}"

if git rev-parse -q --verify "refs/tags/${last}" >/dev/null; then
    subjects="$(git log --format=%s "${last}..HEAD")"
else
    subjects="$(git log --format=%s HEAD)"
fi

if [ -z "${subjects}" ]; then
    printf 'version=%s\nbump=none\nlast=%s\n' "${base}" "${last}"
    exit 0
fi

bump=patch
if printf '%s\n' "${subjects}" | grep -qE '^[a-zA-Z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE'; then
    bump=major
elif printf '%s\n' "${subjects}" | grep -qE '^feat(\([^)]*\))?:'; then
    bump=minor
fi

IFS='.' read -r major minor patch <<< "${base}"
case "${bump}" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
esac

printf 'version=%s.%s.%s\nbump=%s\nlast=%s\n' "${major}" "${minor}" "${patch}" "${bump}" "${last}"
