#!/usr/bin/env bash
# Hourly disk reclaim for the worktree-per-slice model. Both halves refuse to
# touch a busy environment, a dirty checkout or unmerged commits, so this is
# safe to run against a live swarm.
#
# A scheduled runner may copy this file somewhere on its own, away from its
# siblings; ULTRAGOAL_SCRIPTS says where the real ones live.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ -x "$here/worktree-gc.sh" ] || here=${ULTRAGOAL_SCRIPTS:?set ULTRAGOAL_SCRIPTS to the plugin scripts directory}
echo "== worktrees =="
GC_ARGS=--apply "$here/worktree-gc.sh" | tail -2
echo "== node_modules =="
"$here/node-modules-share.sh" dedupe 2>&1 | tail -3
