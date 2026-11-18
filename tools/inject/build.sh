#!/usr/bin/env bash
# Build bin/wl-inject from the vendored wlr virtual-pointer and virtual-keyboard
# protocol XMLs.  Safe to run from anywhere; paths are rooted at the repo.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
proto_dir="$repo_root/tools/inject/protocol"
generated_dir="$repo_root/tools/inject/generated"
bin_dir="$repo_root/bin"

mkdir -p "$generated_dir" "$bin_dir"

scan() {
  local xml="$1"
  local stem="$2"
  wayland-scanner client-header "$proto_dir/$xml" "$generated_dir/$stem.h"
  wayland-scanner private-code "$proto_dir/$xml" "$generated_dir/$stem.c"
}

scan wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1-protocol
scan virtual-keyboard-unstable-v1.xml virtual-keyboard-unstable-v1-protocol

gcc -O2 -Wall -Wextra -o "$bin_dir/wl-inject" \
  "$repo_root/tools/inject/wl-inject.c" \
  "$generated_dir"/*.c \
  $(pkg-config --cflags --libs wayland-client)

echo "built $bin_dir/wl-inject"
