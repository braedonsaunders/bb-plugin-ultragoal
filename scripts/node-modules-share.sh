#!/usr/bin/env bash
# Give every worktree a node_modules that costs nothing on disk.
#
# One agent = one slice means one worktree per slice, and each one ran its own
# `npm install`: thirteen live worktrees held thirteen private copies of the
# same 1.1 GB tree, about 14 GB of identical bytes. Deleting finished worktrees
# reclaimed that space only after the fact; this stops it being spent.
#
# APFS clonefile (`cp -c`) copies by reference. A cloned node_modules is a real,
# independent directory — a worker can install into it, npm can rewrite files —
# but unmodified files share blocks with the store, so the copy is free until
# something diverges. That is why this clones rather than symlinking a single
# shared tree: eight concurrent `npm install` runs into one directory corrupt
# it, and a symlink makes that the default.
#
# The store is keyed by the lockfile hash, so a worktree on a different
# dependency set never receives the wrong tree — it falls back to a real
# install, which is correct and merely slow.
#
#   scripts/node-modules-share.sh seed <checkout>   adopt a good tree into the store
#   scripts/node-modules-share.sh link <checkout>   give this checkout a free copy
#   scripts/node-modules-share.sh dedupe            reclone idle worktrees, free their bytes
#   scripts/node-modules-share.sh status
set -euo pipefail

BB_HOME=${BB_HOME:-$HOME/.bb}
STORE=${NODE_MODULES_STORE:-$BB_HOME/node-modules-store}
WORKTREES="$BB_HOME/worktrees"
BB_DB="$BB_HOME/bb.db"

lock_key() {
  # Which dependency set this tree belongs to. package-lock is authoritative;
  # fall back to package.json so a repo without a lockfile still keys sanely.
  local dir=$1 file
  for file in package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock package.json; do
    if [ -f "$dir/$file" ]; then
      shasum -a 256 "$dir/$file" | cut -c1-16
      return 0
    fi
  done
  return 1
}

clone_tree() {
  # -c asks for clonefile and FAILS on a filesystem that cannot do it, rather
  # than silently writing a full copy and costing the disk this exists to save.
  cp -c -R "$1" "$2" 2>/dev/null || return 1
}

cmd=${1:-status}
case "$cmd" in
  seed)
    src=${2:?usage: node-modules-share.sh seed <checkout>}
    [ -d "$src/node_modules" ] || { echo "seed: $src has no node_modules" >&2; exit 1; }
    key=$(lock_key "$src") || { echo "seed: $src has no lockfile or package.json" >&2; exit 1; }
    mkdir -p "$STORE"
    dest="$STORE/$key"
    if [ -d "$dest" ]; then echo "seed: store already holds $key"; exit 0; fi
    tmp="$dest.incoming.$$"
    rm -rf "$tmp"
    clone_tree "$src/node_modules" "$tmp" || { rm -rf "$tmp"; echo "seed: clone failed (not APFS?)" >&2; exit 1; }
    mv "$tmp" "$dest"
    echo "seed: stored $key ($(du -sh "$dest" 2>/dev/null | cut -f1))"
    ;;

  link)
    dst=${2:?usage: node-modules-share.sh link <checkout>}
    key=$(lock_key "$dst") || { echo "link: $dst has no lockfile or package.json" >&2; exit 1; }
    src="$STORE/$key"
    if [ ! -d "$src" ]; then
      echo "link: no store entry for $key — run npm install here, then 'seed' this checkout"
      exit 2
    fi
    if [ -e "$dst/node_modules" ]; then echo "link: $dst already has node_modules"; exit 0; fi
    tmp="$dst/node_modules.incoming.$$"
    rm -rf "$tmp"
    clone_tree "$src" "$tmp" || { rm -rf "$tmp"; echo "link: clone failed" >&2; exit 1; }
    mv "$tmp" "$dst/node_modules"
    echo "link: $dst now shares $key at no disk cost"
    ;;

  dedupe)
    [ -d "$STORE" ] || { echo "dedupe: no store yet — seed one first" >&2; exit 1; }
    # Never touch a worktree whose thread is mid-turn: replacing node_modules
    # under a running install is how you get a half-installed tree.
    busy=$(sqlite3 -readonly "$BB_DB" "
      select distinct environment_id from threads
       where environment_id is not null and deleted_at is null
         and status in ('active','starting')" 2>/dev/null || true)
    done_count=0
    for nm in "$WORKTREES"/*/*/node_modules; do
      [ -d "$nm" ] || continue
      [ -L "$nm" ] && continue
      checkout=$(dirname "$nm")
      env_id=$(basename "$(dirname "$checkout")")
      case "
$busy
" in *"
$env_id
"*) echo "skip  $env_id (busy)"; continue ;; esac
      key=$(lock_key "$checkout") || continue
      [ -d "$STORE/$key" ] || { echo "skip  $env_id (no store entry for $key)"; continue; }
      tmp="$checkout/node_modules.reclone.$$"
      rm -rf "$tmp"
      if ! clone_tree "$STORE/$key" "$tmp"; then rm -rf "$tmp"; echo "skip  $env_id (clone failed)"; continue; fi
      rm -rf "$nm"
      mv "$tmp" "$nm"
      done_count=$((done_count + 1))
      echo "share $env_id -> $key"
    done
    echo "dedupe: recloned $done_count worktree(s)"
    ;;

  status)
    echo "store: $STORE"
    if [ -d "$STORE" ]; then
      for entry in "$STORE"/*/; do
        [ -d "$entry" ] || continue
        echo "  $(basename "$entry")  $(du -sh "$entry" 2>/dev/null | cut -f1)"
      done
    else
      echo "  (empty)"
    fi
    echo "worktree node_modules: $(find "$WORKTREES" -maxdepth 3 -name node_modules -type d 2>/dev/null | wc -l | tr -d ' ')"
    ;;

  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
