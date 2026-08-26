#!/usr/bin/env bash
# Reclaim managed bb worktrees whose work is finished.
#
# One agent = one slice means one worktree per slice, and nothing ever removed
# them: 201 worktrees and 9.9 GB accumulated for a goal with 177 completed
# items, plus a full node_modules in any worktree whose agent ran an install.
# A worktree whose thread is gone and whose commits are already on the base
# branch is pure disk.
#
# Refuses to remove anything it cannot prove is finished:
#   * an environment with an active or starting thread;
#   * a dirty checkout (uncommitted or untracked files);
#   * commits not reachable from the base branch.
# The last two need --force, which exists for a rebuilt base branch, not for
# convenience.
#
#   scripts/worktree-gc.sh              report only, removes nothing
#   scripts/worktree-gc.sh --apply      remove what qualifies
#   scripts/worktree-gc.sh --apply --force   also remove dirty/unmerged
set -euo pipefail

BB_HOME=${BB_HOME:-$HOME/.bb}
WORKTREES="$BB_HOME/worktrees"
BB_DB="$BB_HOME/bb.db"
APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "worktree-gc: unknown option $arg" >&2; exit 1 ;;
  esac
done

[ -d "$WORKTREES" ] || { echo "worktree-gc: no worktree directory at $WORKTREES"; exit 0; }
[ -f "$BB_DB" ] || { echo "worktree-gc: no bb database at $BB_DB" >&2; exit 1; }

# Read the live databases read-only. WAL handles a concurrent reader, and the
# obvious alternative — .backup to a temp file — copies 1.8 GB per run and then
# could not be reopened, which is worse than the problem it avoided.

# An environment is BUSY when any live thread on it is active or starting.
busy_envs=$(sqlite3 -readonly "$BB_DB" "
  select distinct environment_id from threads
   where environment_id is not null and deleted_at is null
     and status in ('active','starting')" 2>/dev/null || true)

is_busy() {
  case "
$busy_envs
" in *"
$1
"*) return 0 ;; *) return 1 ;; esac
}

# An environment is also OFF LIMITS while the slice it was spawned for is
# unfinished. A worker idle between turns is not "active", and without this a
# live slice's worktree could be reclaimed the moment it happened to be quiet.
# Only agents that actually hold a slice count: an intake agent or a discovered
# child has no item, and treating "no item" as "unfinished" protected 202 of
# 216 worktrees — including every orphan this exists to collect.
UG_DB=${UG_DB:-$BB_HOME/plugins/ultragoal/data.db}
open_envs=""
if [ -f "$UG_DB" ]; then
  # Two queries joined in the shell rather than one with ATTACH: a read-only
  # handle cannot attach a second file, and the failure is silent — it returns
  # no rows, which reads exactly like "nothing to protect".
  open_threads=$(sqlite3 -readonly "$UG_DB" "
    select a.thread_id from collab_agents a
     left join goal_items i
       on i.id = a.item_id and i.thread_id = a.root_thread_id
     where a.item_id is not null
       and (i.status is null or i.status <> 'completed')" 2>/dev/null || true)
  if [ -n "$open_threads" ]; then
    thread_envs=$(sqlite3 -readonly "$BB_DB" "
      select id || ' ' || environment_id from threads
       where environment_id is not null and deleted_at is null" 2>/dev/null || true)
    open_envs=$(awk 'NR==FNR { open[$1]=1; next } ($1 in open) { print $2 }' \
      <(printf '%s\n' "$open_threads") <(printf '%s\n' "$thread_envs") | sort -u)
  fi
fi

has_open_slice() {
  case "
$open_envs
" in *"
$1
"*) return 0 ;; *) return 1 ;; esac
}

kept_busy=0; kept_open=0; kept_dirty=0; kept_unmerged=0; removed=0; freed_kb=0

for dir in "$WORKTREES"/*/; do
  [ -d "$dir" ] || continue
  env_id=$(basename "$dir")
  case "$env_id" in env_*) ;; *) continue ;; esac

  if is_busy "$env_id"; then kept_busy=$((kept_busy + 1)); continue; fi
  if has_open_slice "$env_id"; then kept_open=$((kept_open + 1)); continue; fi

  # The checkout itself is one level down: <worktrees>/<env>/<repo>.
  repo_dir=$(find "$dir" -mindepth 1 -maxdepth 1 -type d | head -1)

  if [ -z "$repo_dir" ] || [ ! -e "$repo_dir/.git" ]; then
    # No checkout left — nothing to lose and nothing git can tell us.
    size_kb=$(du -sk "$dir" 2>/dev/null | cut -f1); size_kb=${size_kb:-0}
    if [ "$APPLY" = 1 ]; then rm -rf "$dir"; fi
    removed=$((removed + 1)); freed_kb=$((freed_kb + size_kb))
    echo "reclaim  $env_id  (no checkout)  $((size_kb / 1024))MB"
    continue
  fi

  if [ -n "$(git -C "$repo_dir" status --porcelain 2>/dev/null)" ] && [ "$FORCE" = 0 ]; then
    kept_dirty=$((kept_dirty + 1)); continue
  fi

  base=$(git -C "$repo_dir" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "")
  [ -n "$base" ] || base=origin/main
  head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$head" ] && ! git -C "$repo_dir" merge-base --is-ancestor "$head" "$base" 2>/dev/null; then
    if [ "$FORCE" = 0 ]; then kept_unmerged=$((kept_unmerged + 1)); continue; fi
  fi

  size_kb=$(du -sk "$dir" 2>/dev/null | cut -f1); size_kb=${size_kb:-0}
  branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  main_repo=$(git -C "$repo_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##' || echo "")
  echo "reclaim  $env_id  ${branch:-detached}  $((size_kb / 1024))MB"
  if [ "$APPLY" = 1 ]; then
    git -C "$repo_dir" worktree remove --force "$repo_dir" 2>/dev/null || rm -rf "$dir"
    rm -rf "$dir"
    if [ -n "$main_repo" ] && [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
      git -C "$main_repo" worktree prune 2>/dev/null || true
      git -C "$main_repo" branch -D "$branch" >/dev/null 2>&1 || true
    fi
  fi
  removed=$((removed + 1)); freed_kb=$((freed_kb + size_kb))
done

echo
echo "worktree-gc: $removed reclaimable ($((freed_kb / 1024))MB); kept $kept_busy busy, $kept_open on unfinished slices, $kept_dirty dirty, $kept_unmerged unmerged"
[ "$APPLY" = 1 ] || echo "worktree-gc: report only — re-run with --apply to remove"
