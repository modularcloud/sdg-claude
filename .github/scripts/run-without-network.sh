#!/usr/bin/env bash
# Run a command with network access disabled (TEST-SPEC E-1: the suite must
# pass with network access disabled after setup, and product invocations run
# with network access denied).
#
# The command runs in a fresh network namespace containing only a loopback
# interface, so the command and every subprocess it spawns (the harness's
# product invocations included) have no route off the machine, while the
# Actions runner agent keeps its own connectivity. Failures here are loud by
# design: falling back to a networked run would silently drop the E-1
# guarantee.
set -euo pipefail

# Ubuntu 24.04 can restrict unprivileged user namespaces; lift the restriction
# for this VM so `unshare` needs no root. A no-op where already permitted.
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true

# --map-root-user grants CAP_NET_ADMIN inside the new namespaces (to bring up
# loopback); the real uid outside remains the runner user.
exec unshare --map-root-user --net -- \
  sh -c 'ip link set lo up 2>/dev/null || true; exec "$@"' -- "$@"
