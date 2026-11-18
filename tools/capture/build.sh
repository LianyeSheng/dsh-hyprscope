#!/usr/bin/env bash
# Build bin/wl-capture from the vendored ext-foreign-toplevel-list,
# ext-image-capture-source and ext-image-copy-capture protocol XMLs.
# Safe to run from anywhere; paths are rooted at the repo.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
proto_dir="$repo_root/tools/capture/protocol"
generated_dir="$repo_root/tools/capture/generated"
bin_dir="$repo_root/bin"

mkdir -p "$generated_dir" "$bin_dir"

scan() {
  local xml="$1"
  local stem="$2"
  wayland-scanner client-header "$proto_dir/$xml" "$generated_dir/$stem.h"
  wayland-scanner private-code "$proto_dir/$xml" "$generated_dir/$stem.c"
}

scan ext-foreign-toplevel-list-v1.xml ext-foreign-toplevel-list-v1-protocol
scan ext-image-capture-source-v1.xml ext-image-capture-source-v1-protocol
scan ext-image-copy-capture-v1.xml ext-image-copy-capture-v1-protocol

gcc -O2 -Wall -Wextra -I"$generated_dir" -o "$bin_dir/wl-capture" \
  "$repo_root/tools/capture/wl-capture.c" \
  "$generated_dir"/*.c \
  $(pkg-config --cflags --libs wayland-client)

echo "built $bin_dir/wl-capture"
