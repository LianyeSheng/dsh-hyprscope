#!/usr/bin/env bash
# Record the two README demos.
#
#   scripts/demo-gif.sh --scene shared    # the agent drives YOUR browser after one approval
#   scripts/demo-gif.sh --scene terminal  # the smaller demo: type one line in a terminal
#   scripts/demo-gif.sh --scene desktop   # the agent works in its OWN desktop window
#   scripts/demo-gif.sh --dry             # 3 seconds of a demo terminal, no consent
#
# --app <id> picks the browser application id for --scene shared (default: zen).
#
# Capturing is a grim frame loop (no wf-recorder) assembled by ffmpeg. The
# consent card is a layer-shell surface, so it never appears in `clients`.
set -uo pipefail

scene="shared"
lang="en"
fps=10
app="zen"
work_rel=".tmp/demo-gif"

while [ $# -gt 0 ]; do
  case "$1" in
    --scene) scene="$2"; shift ;;
    --app) app="$2"; shift ;;
    --lang) lang="$2"; shift ;;
    --fps) fps="$2"; shift ;;
    --dry) scene="dry" ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$scene" in
  shared) out="docs/assets/demo-shared.gif" ;;
  desktop) out="docs/assets/demo-agent-desktop.gif" ;;
  terminal) out=".tmp/demo-terminal.gif" ;;
  dry) out=".tmp/demo-dry.gif" ;;
  *) echo "unknown scene: $scene" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

for bin in node ffmpeg grim foot; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
[ "$scene" = "dry" ] || command -v quickshell >/dev/null || { echo "missing: quickshell (the consent card)" >&2; exit 1; }

# The harness process usually sits outside the graphical session: take the
# display, runtime dir and signature from hyprscope's own discovery.
eval "$(node bin/hyprscope.ts doctor --json | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const d = JSON.parse(s).discovery
  console.log("export WAYLAND_DISPLAY=" + JSON.stringify(d.waylandDisplay)
    + " XDG_RUNTIME_DIR=" + JSON.stringify(d.runtimeDir)
    + " HYPRLAND_INSTANCE_SIGNATURE=" + JSON.stringify(d.instanceSignature))
})')"

monitor="$(hyprctl monitors -j | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const list = JSON.parse(s); const m = list.find(x => x.focused) || list[0]
  console.log(m && m.name ? m.name : "")
})')"
[ -n "$monitor" ] || { echo "no focused monitor" >&2; exit 1; }

work="$work_rel"
rm -rf "$work"; mkdir -p "$work/frames"
touch "$work/keep"
interval="$(node -e "console.log((1/$fps).toFixed(3))")"

loop_pid=""; foot_pid=""; desktop_started=0
cleanup() {
  touch "$work/stop"
  [ -n "$loop_pid" ] && kill "$loop_pid" 2>/dev/null
  [ -n "$foot_pid" ] && kill "$foot_pid" 2>/dev/null
  if [ "$desktop_started" = "1" ]; then
    node bin/hyprscope.ts control desktop stop --json >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

start_frames() {
  (
    i=0
    while [ ! -f "$work/stop" ] && [ $i -lt 1800 ]; do
      grim -o "$monitor" "$(printf '%s/frames/%05d.png' "$work" "$i")" 2>/dev/null
      i=$((i + 1))
      sleep "$interval"
    done
  ) &
  loop_pid=$!
}

assemble() {
  local frames
  frames=$(ls "$work"/frames/*.png 2>/dev/null | wc -l)
  echo "frames: $frames"
  [ "$frames" -ge 5 ] || { echo "not enough frames, nothing assembled"; return 1; }
  mkdir -p "$(dirname "$out")"
  # Hold the last frame for two seconds: the run itself can be over in 150ms,
  # and a loop that ends before the result is readable is not a demo.
  ffmpeg -y -loglevel error -framerate "$fps" -i "$work/frames/%05d.png" \
    -vf "scale=1100:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=2,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
    -loop 0 "$out"
  local mp4="${out%.gif}.mp4"
  ffmpeg -y -loglevel error -framerate "$fps" -i "$work/frames/%05d.png" \
    -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart "$mp4"
  echo "gif: $out ($(du -h "$out" | cut -f1))"
  echo "mp4: $mp4 ($(du -h "$mp4" | cut -f1))"
}

open_demo_terminal() {
  foot -a hyprscope-demo -F >/dev/null 2>&1 &
  foot_pid=$!
  for _ in $(seq 1 50); do
    node bin/hyprscope.ts clients --json 2>/dev/null | grep -q hyprscope-demo && return 0
    sleep 0.1
  done
  return 1
}

if [ "$scene" = "dry" ]; then
  open_demo_terminal || { echo "the demo terminal did not map" >&2; exit 1; }
  sleep 0.8
  start_frames
  sleep 3
  touch "$work/stop"; wait "$loop_pid" 2>/dev/null; loop_pid=""
  assemble
  exit $?
fi

echo
if [ "$scene" = "terminal" ]; then
  echo "Scene: the agent types one line into a terminal on YOUR desktop."
  open_demo_terminal || { echo "the demo terminal did not map" >&2; exit 1; }
  sleep 0.8
  start_frames
  echo "A consent card will appear: click Allow (允许操控), then leave the mouse alone."
  node bin/hyprscope.ts control run plans/demo-terminal.json --lang "$lang" --consent 40
  sleep 1.2
  touch "$work/stop"; wait "$loop_pid" 2>/dev/null; loop_pid=""
  assemble
  exit $?
fi

if [ "$scene" = "shared" ]; then
  echo "Scene: the agent drives YOUR browser: new tab, address, Return, scroll, capture."
  if ! node bin/hyprscope.ts clients --json | grep -q "$app"; then
    echo "no window with app id \"$app\": open your browser first, or pass --app <id>" >&2
    exit 1
  fi
  # The checked-in plan targets one application id; the scene rewrites just that
  # field so the same demo works on another machine without editing the plan.
  plan="$work/plan.json"
  node -e '
const fs = require("node:fs")
const plan = JSON.parse(fs.readFileSync("plans/demo-browser.json", "utf8"))
const app = process.argv[1]
const swap = value => {
  if (Array.isArray(value)) return value.map(swap)
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = key === "app" ? app : swap(inner)
    return out
  }
  return value
}
fs.writeFileSync(process.argv[2], JSON.stringify(swap(plan), null, 2))
' "$app" "$plan"
  start_frames
  echo "A consent card will appear: click Allow (允许操控), then leave the mouse alone."
  node bin/hyprscope.ts control run "$plan" --lang "$lang" --consent 40
  sleep 1.5
  touch "$work/stop"; wait "$loop_pid" 2>/dev/null; loop_pid=""
  assemble
  exit $?
fi

# scene=desktop: one consent at desktop start, then the agent works inside it.
# A nested desktop is a new compositor instance, so it also needs its own
# capability probe; `desktop start` runs that measurement itself, which is why
# this stays at one click.
echo "Scene: the agent works in its OWN desktop; keep using your machine."
start_frames
echo "1/2 consent at desktop start: click Allow once on YOUR desktop."
echo "    The new desktop is measured automatically; no second card."
node bin/hyprscope.ts control desktop start --size 1280x800 --consent-source card
desktop_started=1

if ! node bin/hyprscope.ts control desktop status --json | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  try { const j = JSON.parse(s); process.exit(j.baseline && j.baseline.present ? 0 : 1) } catch { process.exit(1) }
})'; then
  echo "start did not manage to measure the new desktop; probing it once instead." >&2
  node bin/hyprscope.ts control baseline --probe --desktop agent || exit 1
fi
echo "2/2 the agent acts inside its own desktop."

status="$(node bin/hyprscope.ts control desktop status --json)"
read -r nested_rt nested_sig nested_wd <<<"$(printf '%s' "$status" | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const pick = o => o && (o.runtimeDir || o.runtime_dir)
  const walk = v => {
    if (!v || typeof v !== "object") return null
    if (pick(v)) return v
    for (const k of Object.keys(v)) { const hit = walk(v[k]); if (hit) return hit }
    return null
  }
  const r = walk(JSON.parse(s))
  if (!r) return
  console.log([r.runtimeDir || r.runtime_dir, r.signature, r.waylandDisplay || r.wayland_display].join(" "))
})')"

if [ -z "${nested_wd:-}" ]; then
  echo "could not read the nested desktop instance from status" >&2
  exit 1
fi

# A terminal inside the nested desktop, so the plan has something to type into.
WAYLAND_DISPLAY="$nested_wd" XDG_RUNTIME_DIR="$nested_rt" HYPRLAND_INSTANCE_SIGNATURE="$nested_sig" \
  foot -a hyprscope-demo -F >/dev/null 2>&1 &
nested_foot=$!
sleep 1.5

node bin/hyprscope.ts control run plans/demo-terminal.json --desktop agent --lang "$lang" --consent 20
sleep 1.5
touch "$work/stop"; wait "$loop_pid" 2>/dev/null; loop_pid=""
kill "$nested_foot" 2>/dev/null
assemble
