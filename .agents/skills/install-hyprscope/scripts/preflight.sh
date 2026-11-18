#!/usr/bin/env bash
# Read-only preflight for install-hyprscope.
# Usage: bash preflight.sh [checkout]
# Prints ok/warn/MISS lines; exits 1 when a required item is missing.
# It never installs, downloads, or changes anything.
set -u

repo="${1:-$(pwd)}"
root="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || root="$repo"

fail=0
ok()   { printf 'ok    %s\n' "$*"; }
warn() { printf 'warn  %s\n' "$*"; }
miss() { printf 'MISS  %s\n' "$*"; fail=1; }

printf '== install-hyprscope preflight ==\n'
printf 'checkout: %s\n' "$root"
printf 'system:   %s %s\n' "$(uname -s 2>/dev/null || echo unknown)" "$(uname -m 2>/dev/null || echo unknown)"

if [ -f "$root/bin/hyprscope.ts" ] && [ -f "$root/package.json" ] \
  && grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-hyprscope"' "$root/package.json"; then
  ok "hyprscope checkout (bin/hyprscope.ts, package.json)"
else
  miss "not a hyprscope checkout: $root (expected bin/hyprscope.ts and \"name\": \"dsh-hyprscope\")"
fi

printf '\n-- required --\n'

if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.version' 2>/dev/null || echo unknown)"
  typescript="$(node -p 'process.features.typescript ?? "undefined"' 2>/dev/null || echo unknown)"
  case "$typescript" in
    strip|transform) ok "node $node_version (TypeScript type stripping: $typescript)" ;;
    *) miss "node $node_version: type stripping is $typescript (need Node >=22.18; Node 24 LTS recommended)" ;;
  esac
else
  miss "node not found (need Node >=22.18; Node 24 LTS recommended)"
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version 2>/dev/null || echo unknown)"
  case "$pnpm_version" in
    12.*) ok "pnpm $pnpm_version" ;;
    *) warn "pnpm $pnpm_version; this checkout pins 12.20.0, and another major may misread pnpm-lock.yaml" ;;
  esac
else
  miss "pnpm not found (pin 12.20.0: corepack enable && corepack prepare pnpm@12.20.0 --activate)"
fi

if command -v gcc >/dev/null 2>&1; then
  ok "gcc $(gcc -dumpversion 2>/dev/null || echo present)"
else
  miss "gcc not found (needed by build:probe, build:inject, build:scratch)"
fi

if command -v pkg-config >/dev/null 2>&1; then
  if wayland_version="$(pkg-config --modversion wayland-client 2>/dev/null)"; then
    ok "wayland-client $wayland_version (pkg-config)"
  else
    miss "wayland-client development files not found (libwayland-dev / wayland-devel)"
  fi
else
  miss "pkg-config not found (needed by the C builds)"
fi

if command -v wayland-scanner >/dev/null 2>&1; then
  ok "wayland-scanner present"
else
  miss "wayland-scanner not found (libwayland-bin / wayland-devel)"
fi

protocol_dir="$(pkg-config --variable=pkgdatadir wayland-protocols 2>/dev/null || true)"
protocol_dir="${protocol_dir:-/usr/share/wayland-protocols}"
if [ -f "$protocol_dir/stable/xdg-shell/xdg-shell.xml" ]; then
  ok "wayland-protocols ($protocol_dir)"
else
  miss "xdg-shell.xml not found under $protocol_dir (install wayland-protocols)"
fi

printf '\n-- runtime and control --\n'

if [ -n "${HYPRSCOPE_QUICKSHELL:-}" ] && [ -x "${HYPRSCOPE_QUICKSHELL}" ]; then
  ok "quickshell override: $HYPRSCOPE_QUICKSHELL"
elif command -v quickshell >/dev/null 2>&1; then
  ok "quickshell ($(command -v quickshell))"
elif command -v qs >/dev/null 2>&1; then
  warn "quickshell is not on PATH; qs is at $(command -v qs) (set HYPRSCOPE_QUICKSHELL=$(command -v qs) so the overlay finds it)"
else
  warn "quickshell/qs not found: consent cards and the baseline probe cannot run (set HYPRSCOPE_QUICKSHELL)"
fi

if command -v grim >/dev/null 2>&1; then
  ok "grim ($(command -v grim))"
else
  warn "grim not found: screenshots will be unavailable"
fi

if command -v loginctl >/dev/null 2>&1; then
  ok "loginctl present (best-effort lock state)"
else
  warn "loginctl not found: lock state will be unavailable"
fi

signature="${HYPRLAND_INSTANCE_SIGNATURE:-}"
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -n "$signature" ] && [ -d "$runtime_dir/hypr/$signature" ]; then
  ok "Hyprland session in the environment ($signature)"
elif compgen -G "$runtime_dir/hypr/*/.socket.sock" >/dev/null 2>&1; then
  warn "Hyprland instance directories exist under $runtime_dir/hypr but are not in the environment; doctor will confirm discovery"
else
  warn "no Hyprland session under $runtime_dir/hypr: doctor, probe, and baseline will be unavailable"
fi

if command -v hyprctl >/dev/null 2>&1; then
  ok "hyprctl present"
else
  warn "hyprctl not found (is Hyprland installed?)"
fi

printf '\n-- DeepSeek Harness (optional) --\n'

if [ -n "${DSH_HOME:-}" ] && [ -d "${DSH_HOME}" ]; then
  ok "DSH detected (DSH_HOME=$DSH_HOME); the plugin stage is available"
elif [ -d "${HOME:-}/.local/share/deepseek-harness" ]; then
  ok "DSH checkout detected (~/.local/share/deepseek-harness); the plugin stage is available"
elif command -v dsh >/dev/null 2>&1; then
  ok "dsh on PATH; the plugin stage is available"
else
  warn "no DeepSeek Harness detected; skip the plugin stage"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'preflight: install prerequisites passed (control also needs a session, Quickshell, and a fresh baseline)\n'
else
  printf 'preflight: fix the required items above and re-run this script\n'
fi
exit "$fail"
