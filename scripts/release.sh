#!/usr/bin/env bash
# scripts/release.sh — mechanical release automation for squad-kit.
#
# This script does NOT write commit messages or decide when to release. It
# exposes small, idempotent subcommands so a human (or an agent driving git)
# can orchestrate a clean release:
#
#   preflight           sanity-check: branch, clean tree, npm auth, gh auth
#   bump <x.y.z>        bump version in package.json + src/cli.ts
#   verify              pnpm build + pnpm test + pnpm lint
#   push                tag v<current> and push main + tag to origin
#   publish [--otp X]   npm publish --access public (interactive OTP if omitted)
#   release             create GitHub release from [<current>] CHANGELOG section
#   smoke               npm view + npx --version post-publish sanity check
#
# Typical flow for a patch release once commits are in place:
#   scripts/release.sh preflight
#   scripts/release.sh bump 0.2.3    # then hand-edit CHANGELOG, commit both
#   scripts/release.sh verify
#   scripts/release.sh push
#   scripts/release.sh publish       # paste OTP when prompted
#   scripts/release.sh release
#   scripts/release.sh smoke
#
# The script is deliberately boring: it only chains the commands you would
# otherwise type, with pre-flight guards and consistent output. It never
# invents commit messages, never amends history, and never force-pushes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

MAIN_BRANCH="main"

# ── output helpers ───────────────────────────────────────────────────────────
log()  { printf "\033[1;36m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# ── helpers ──────────────────────────────────────────────────────────────────
current_version() { node -p "require('./package.json').version"; }

require_main() {
  local br
  br=$(git rev-parse --abbrev-ref HEAD)
  [[ "$br" == "$MAIN_BRANCH" ]] || die "not on $MAIN_BRANCH (on $br). Switch first."
}

require_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git status --short
    die "working tree is dirty. Commit or stash first."
  fi
  if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    git status --short
    die "untracked files present. Commit, ignore, or remove first."
  fi
}

extract_changelog_section() {
  local ver="$1"
  awk -v ver="$ver" '
    $0 ~ "^## \\[" ver "\\]" { found=1; next }
    found && /^## \[/        { exit }
    found                    { print }
  ' CHANGELOG.md | sed -e '/./,$!d' | awk 'NF{p=1} p'
}

# ── subcommands ──────────────────────────────────────────────────────────────
cmd_preflight() {
  require_main
  log "checking working tree..."
  require_clean_tree
  log "checking npm auth..."
  npm whoami >/dev/null 2>&1 || die "npm whoami failed — run \`npm login\` first"
  log "checking gh auth..."
  if ! gh auth status >/dev/null 2>&1; then
    warn "gh auth not set up — \`release\` subcommand will fail. Run \`gh auth login\` when needed."
  fi
  ok "preflight clean (current version $(current_version))"
}

cmd_bump() {
  local new="${1:-}"
  [[ -n "$new" ]] || die "usage: release.sh bump <x.y.z>"
  [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be x.y.z, got: $new"
  local cur
  cur=$(current_version)
  [[ "$cur" != "$new" ]] || die "already at $new; nothing to bump"

  log "bumping $cur → $new"
  npm version --no-git-tag-version "$new" >/dev/null

  if grep -q "\.version('$cur')" src/cli.ts; then
    local tmp
    tmp=$(mktemp)
    sed "s/\.version('$cur')/\.version('$new')/" src/cli.ts >"$tmp" && mv "$tmp" src/cli.ts
  else
    warn "src/cli.ts does not contain .version('$cur') — skipped"
  fi

  ok "bumped to $new. Edit CHANGELOG.md [$new] section, then commit:"
  printf "    git add package.json src/cli.ts CHANGELOG.md\n"
  printf "    git commit -m \"chore: release %s\"\n" "$new"
}

cmd_verify() {
  log "pnpm build"
  pnpm build
  log "pnpm test"
  pnpm test
  log "pnpm lint"
  pnpm lint
  ok "verify clean"
}

cmd_push() {
  require_main
  require_clean_tree
  local ver tag
  ver=$(current_version)
  tag="v$ver"

  if git rev-parse "$tag" >/dev/null 2>&1; then
    warn "tag $tag already exists locally — skipping tag create"
  else
    log "creating tag $tag"
    git tag -a "$tag" -m "$tag"
  fi

  log "git push origin $MAIN_BRANCH"
  git push origin "$MAIN_BRANCH"

  log "git push origin $tag"
  git push origin "$tag"

  ok "pushed $MAIN_BRANCH + $tag"
}

cmd_publish() {
  local otp=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --otp) otp="${2:-}"; shift 2 ;;
      --otp=*) otp="${1#--otp=}"; shift ;;
      *) die "unknown arg to publish: $1" ;;
    esac
  done

  local ver
  ver=$(current_version)

  local args=(--access public)
  [[ -n "$otp" ]] && args+=(--otp "$otp")

  log "npm publish ${args[*]}"
  npm publish "${args[@]}"

  ok "published squad-kit@$ver to npm"
}

cmd_release() {
  local ver tag notes
  ver=$(current_version)
  tag="v$ver"

  notes=$(extract_changelog_section "$ver")
  if [[ -z "$notes" ]]; then
    warn "no CHANGELOG entry for [$ver]; falling back to tag annotation"
    gh release create "$tag" --title "$tag" --notes-from-tag
  else
    printf '%s\n' "$notes" | gh release create "$tag" --title "$tag — $(date -u +%Y-%m-%d)" --notes-file -
  fi

  ok "created GitHub release $tag"
}

cmd_smoke() {
  local ver
  ver=$(current_version)

  log "npm view squad-kit version"
  local registry_ver
  registry_ver=$(npm view squad-kit version)
  [[ "$registry_ver" == "$ver" ]] || die "registry shows $registry_ver, expected $ver"

  log "npx squad-kit@$ver --version (in /tmp)"
  local printed
  printed=$(cd /tmp && npx -y --package="squad-kit@$ver" squad --version)
  [[ "$printed" == "$ver" ]] || die "squad --version printed $printed, expected $ver"

  ok "smoke clean — registry and CLI both report $ver"
}

cmd_help() {
  cat <<'EOF'
usage: scripts/release.sh <subcommand> [args]

subcommands:
  preflight           branch, clean tree, npm auth, gh auth
  bump <x.y.z>        package.json + src/cli.ts version bump
  verify              pnpm build + pnpm test + pnpm lint
  push                tag v<current> (if missing) and push main + tag
  publish [--otp X]   npm publish --access public
  release             gh release create <tag> with [<ver>] CHANGELOG body
  smoke               post-publish sanity (registry + npx)

This script does not write commits. Stage and commit changes yourself with
messages matching the repo's style.
EOF
}

# ── dispatch ─────────────────────────────────────────────────────────────────
case "${1:-help}" in
  preflight) shift; cmd_preflight "$@" ;;
  bump)      shift; cmd_bump "$@" ;;
  verify)    shift; cmd_verify "$@" ;;
  push)      shift; cmd_push "$@" ;;
  publish)   shift; cmd_publish "$@" ;;
  release)   shift; cmd_release "$@" ;;
  smoke)     shift; cmd_smoke "$@" ;;
  help|-h|--help) cmd_help ;;
  *) die "unknown subcommand: $1 (run \`$0 help\`)" ;;
esac
