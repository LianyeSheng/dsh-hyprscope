# On-machine verification record

English | [中文](/docs/VERIFICATION.zh.md)

This is the record of one on-machine verification, not an ongoing guarantee. The numbers and versions hold only for this environment; changing machines, upgrading Hyprland or changing configuration can all move them. To confirm the current state, just run `pnpm run typecheck && pnpm test && pnpm run doctor`. Verified on: 2026-11-17 and 2026-11-18, covering the observation layer, the control lease, plan execution and input injection, the interference prompt and derived recovery, and — on 2026-11-18 — the agent desktop, drift detection, the consent surface and the probe's move onto a measure plan. Command spellings in this record are normalised to the current single entry point: the earlier runs used the pre-merge `hyprlease` binary, so the observations stand, but the commands are written below as `hyprscope control ...`. Layer namespaces shown as `hyprlease-*` are historical labels; the current names are `hyprscope-*`.

## Environment

- System: CachyOS (an Arch-based rolling distribution)
- Compositor: Hyprland 0.57.2, Lua configuration, `drm` backend, a single `wl_seat`
- Output: `HDMI-A-1`, 2560×1440, scale 1
- Runtime: Node v26.13.1, pnpm 12.20.0, TypeScript 7.0.2 (type checking only)
- Caller environment: both `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` were empty, and the verification process was not inside the graphical session

## Observation layer

`pnpm run doctor` (with the Wayland probe compiled) identified 1 Hyprland instance, with the Wayland display `wayland-1`; the probe reported 73 Wayland global objects and `seatCount 1`, and protocols such as `zwp_virtual_keyboard_manager_v1`, `zwlr_virtual_pointer_manager_v1` and `zwlr_screencopy_manager_v1` were present.

`node bin/hyprscope.ts state` read `HDMI-A-1` (2560×1440, scale 1), the active window on workspace 1, 7 layer-shell surfaces under `layers`, and the cursor's global coordinates as well.

A full-layout screenshot at 2560×1440 succeeded; a region screenshot with `--region 0,0,640,360` also succeeded, both decoded the width and height from the PNG header, and the response carried the file size and sha256.

`pnpm test` passed 70 tests at that point (64 unit tests plus 6 live integration tests); `pnpm run typecheck` reported no errors. The live tests connect to the same compositor, and the whole group is skipped when no session is available. The session discovery path was covered against a real unix socket.

## Control lease

Verified item by item on the test machine on 2026-11-17:

- Consent card: `hyprscope control request --reason "检查同意卡片与横幅切换" --ttl 120 --consent 90` popped a full-screen modal card (`hyprlease-consent` in `hyprscope layers`, level 3, covering 2560×1440), with the copy, the reason, the countdown and the deny/allow buttons all correct. Screenshot: `out/lease-consent-2.png`.
- Banner after approval: after the consent was recorded, `status` became `granted` and the layer became `hyprlease-banner` (2560×56), showing the remaining time and "Revoke now". Screenshot: `out/lease-banner-2.png`.
- Voluntary handback: after `hyprscope control done`, `phase: released` and the layer disappeared.
- Forced revocation: after `hyprscope control panic`, `phase: revoked` and the layer disappeared (`out/lease-after-failsafe.png` is the clean desktop).
- Fallback shortcut: `install-bind` wrote the marker block into `~/.config/hypr/hyprland.lua` and verified it through `description` in `hyprctl binds -j` (`modmask 72`, `key Escape`, `description` containing `hyprscope`), and `hyprctl configerrors` was empty; running the bound command directly (`/usr/bin/node .../bin/hyprscope.ts control panic --source shortcut`) took a `granted` lease to `revoked`.
- Leftover records: a different lease's `control.json` does not affect a new lease (covered by unit tests); every `request` clears the previous round's decision/control/heartbeat.
- TTL expiry, heartbeat orphan cleanup and a `panic` during the `consent` phase all have unit tests; they were not each checked against the real UI.

## Plan execution and input injection

Build: `pnpm run build:inject` generated all protocol headers from the empty `tools/inject/generated/` and linked `bin/wl-inject` with no warnings; `--probe` reported `zwlr_virtual_pointer_manager_v1` v2 (global 30) and `zwp_virtual_keyboard_manager_v1` v1 (global 29), and one seat.

**Test machine dispatch semantics**: this compositor uses a Lua configuration provider, so the arguments to `hyprctl dispatch` are evaluated as Lua and classic string dispatchers do not take effect (`hyprctl dispatch focuswindow address:0x...` reports a Lua syntax error outright). All dispatch calls became `hl.dsp.*` expressions generated from allowlist templates (`focus`, `window.move`, `window.resize`, `window.float`, `window.pin`), with arguments validated for format before being concatenated; the six semantic operations `focuswindow`, `workspace`, `movewindowpixel`, `resizepixel`, `float` and `pin` were each checked in practice for their effect (position, size, floating, pin, focus, workspace switch).

**Keyboard injection**: at first keys were sent as `evdev + 8`, following the protocol XML comment, and every character was off by one row (`e`→`[`); reading the Hyprland 0.57.2 source confirmed that its virtual-keyboard path treats the `key` argument as **raw evdev** and adds `+8` internally for xkbcommon, so the code switched to sending raw evdev and to sending `modifiers` explicitly when synthesizing modifier keys on press/release. After the fix, `text`, `chord` (including `CTRL+c`) and `keysym` were verified item by item in a real terminal: `echo test123` echoed correctly, `echo 'ABC xyz 0123 !@#$%^&*()_+-=[]{};:,.<>/?|~'` covered the full character set correctly, and `CTRL+c` could interrupt a foreground command.

**Full plan execution chain**: `plans/live-terminal.json` (focus → click → text → chord Return → screenshot, 5 steps, budget 8000ms) ran through on a real lease, `status` returned `completed`, and it took 646ms:

- The consent card showed the plan summary and `sha256 ce69a2839522…` (screenshot `out/plan-consent-3.png`);
- The click landed at `1513,940`, resolved from the anchor point; `text` typed 19 characters and `chord` sent Return;
- The window screenshot `out/runs/20261117T092224-06fc95/step-04-terminal.png` showed `echo hyprscope-live` and the output `hyprscope-live` in the terminal;
- Run artifacts: `plan.json` (with the hash), `timeline.jsonl`, `step-04-terminal.png`, `result.json`; the lease was released in `finally`, and `status` was `released` afterwards.

**Failure paths were also exercised** (these really happened during debugging, they are not constructed):

- Target window does not exist: `faulted`, `broken.kind = target.missing`, `committed: []`, with a fault screenshot;
- Absolute-coordinate extent mismatch: the click landed elsewhere, the click step's `expect` failed, `faulted`, `broken.kind = window.focused`, and `committed` held only the confirmed step 0 — showing that "a click without a receipt is not replayed";
- dispatch syntax error: `faulted` on the first step, with `broken.detail` carrying the compositor's original error.

**Human-interface fixes (second round, 2026-11-17)**:

- The consent card's buttons were previously bound to two undefined properties (`nodePath`/`binPath`), so a click only started an empty command and nothing happened; the properties are now filled in and the UI is optimistic: the card collapses on click and the banner immediately shows "Handing over control…".
- The banner used to be killed by the requester as soon as the lease ended, so no receipt was ever visible; now the executor writes `progress.json` step by step, the banner shows "Running k/n · op", and on a normal end (done/denied/expired) the overlay keeps itself alive for about 2.4 seconds to show the result before exiting — only `revoked` (the host taking control back) makes it disappear immediately. Screenshots `out/ux-banner-sequence.png` (handing over → running 4/9 → 6/9 → 9/9) and `out/ux-10-receipt.png` (run complete · 9 steps).
- The overlay used to be a child process of the requester with stderr on a pipe; as soon as the requester exited the pipe closed, and the overlay's next stderr write took a SIGPIPE and killed it outright, so the receipt could never render. The overlay now uses its own log fd and `detach`, decoupled from the requester's lifetime.
- The "Revoke now" button on the banner used to call an internal consent-phase entry, which is only valid in the consent phase, so on the granted phase the click did nothing; it now calls `hyprscope control panic` (taking the holder's handback path).

**The consent card is not authentication**: this round also surfaced a more fundamental problem — the consent card and injection share the same seat, so an agent can click its own "Allow" directly with `bin/wl-inject`. Confirmed on the machine (it showed up when the button's availability was tested with an injected click). The mitigation added: the injection helper now requires a lease proof (`--lease-state/--lease/--plan`), re-reads `state.json` before every command that injects, and refuses when `phase` is not `granted`, when the id/hash does not match, or when the lease has expired; injection during the `consent` phase returned `lease gate: phase is "consent", not "granted"` in practice, and it is refused after `revoked` as well. Every approval also records its source: `grantedBy` is visible in `status` (`overlay` for the card button, `cli` for the data plane). The consent state is still data-plane state under the same uid, so the same uid can forge it; a real boundary needs a broker with a separate uid or a separate compositor, see `docs/cli/LEASE.md`.

**Blocking interference prompt (third round, 2026-11-17)**: recoverable interference is no longer repaired automatically. The executor first publishes `interference.json` (with an id, the k/n step, the broken assumption and a countdown), the overlay pops a modal card, and only when the host chooses "Continue" does it restore and replay; choosing "Terminate" or leaving it unanswered until it times out faults the run and keeps the confirmed steps. `repairGraceMs` in plans was accordingly replaced by `interferencePromptMs` (default 12 seconds). (This paragraph records the implementation at the time; the fourth round replaced in-place repair entirely with derived recovery plans, so the `repairable`/`repairs` fields and `repairGraceMs` have all been removed from the code and are kept here only to show how it evolved.)

On-machine verification (`interference-demo` plan, 4 steps, `interferencePromptMs: 8000`): injection was used between steps to move the cursor away and create a `pointer.position` violation; the card popped the `hyprlease-interference` layer (2560×1440, level 3), showing `第 3/4 步 · pointer.position` and an 8-second countdown (screenshot `out/iface-prompt.png`). After choosing "Continue" the executor restored the cursor and replayed the step, the run was `completed`, and the step was recorded as `repaired 1`; in another run choosing "Terminate" left the run `faulted`, with `committed` holding only step 0 and `broken.detail` equal to `pointer is not where the step expects it (host chose to terminate)`.

This round's testing also caught a false positive: the `activewindow` event produced by our own `focusWindow` dispatch could arrive after the commit window and be treated as host interference, faulting the run outright. The executor now records the expected echo event kinds per op and attributes them within 2 seconds (`ECHO_KINDS`); after the fix the same plan no longer produced a misjudgment.

**Recovery becomes a derived plan (fourth round, 2026-11-17)**: the third round's "repair in place, then replay" was replaced by "suspend + a derived recovery plan". The criterion is just one: only premises the tool itself can observe and re-establish with the existing dispatch allowlist are recovered; closed windows, changed app surfaces and monitor changes are never recovered — the run faults outright and hands the facts back to the caller.

- **Restorability** is decided per predicate kind (`PREDICATE_SPECS.restore`): `window.focused`, `window.state`, `workspace.active` and `pointer.position` are restorable; `window.geometry` is only restored while the window is floating (a tiled window's geometry belongs to the layout); `window.exists`/`clients.set`/`monitor.config`/`region.*`/`time.budget`/`lease.valid` are not restorable. When the executor finds a broken premise during preflight it first judges with the current snapshot; only when everything is restorable does it send the prompt, and any non-restorable premise faults immediately without a card.
- **Derivation order** is fixed as workspace → window structure (leave fullscreen, floating, pin) → geometry (move + resize) → focus → pointer. The basis is the compositor's actual dependencies: while fullscreen the move/resize calls are rejected (`Window is fullscreen` in the source), resize/move can change focus, and `focus` pulls the cursor into the window and may also switch workspaces.
- **Suspend**: after the host chooses "Continue", this attempt ends as `suspended` (`suspended.json` records the broken premises, `committed` and the baseline geometry), `run` re-observes the desktop, synthesizes restore steps in code, appends the original plan's uncommitted steps, and obtains a new plan carrying `lineage` (`rootPlanId`/`rootPlanHash`/`attempt`/`interruptedAtStep`/`broken`); the new plan has its own `budgetMs` and new hash, and the lease is renewed in place with `renewLease` (same `leaseId`, `attempt` incremented by one, `expiresAt` moved forward, a `renewals[]` entry appended), so recovery has its own time window and needs no second consent.
- **Recover only once**: `maxResumes` defaults to 1 (capped at 3, adjustable with `--max-resumes`), and a premise break inside the derived attempt faults outright (`the recovery attempt may not recover again`). The recovery budget is the original `budgetMs`, and the total budget is `(1 + maxResumes) × budgetMs`.

On-machine verification (`recover-demo` plan: 9 steps, `budgetMs 14000`, `settleMs 700`): focus → float → move to `140,120` → resize to `720×480` → pause 900ms → click (`requires` focus + explicit geometry) → type → Return → screenshot. During the pause, `hl.dsp.window.move` was used to move the target window to `300,220` to create geometry drift, and reaching the click's preflight triggered:

- The prompt card (`out/ux-recovery-prompt.png`): `检测到外部操作`, `第 6/9 步 · 第 1/1 次恢复`, `window.geometry · window geometry changed beyond tolerance`, `继续将恢复前提并追加 14s 执行窗口（本次运行最多恢复 1 次）`, and a 15-second countdown.
- Choosing "Continue": the banner switched to the amber `恢复中 · 第 4/6 步（第 1 次恢复）` (`out/ux-recovery-running.png`), the restore steps first moved the window back to `140,120` and resized it back to `720×480`, and then click/text/Return continued; the run was `completed` and the receipt read `执行完成 · 9 步（含 1 次恢复）` (`out/ux-recovery-banner.png`). `out/runs/20261117T112528-c8286a/step-05-recovered.png` in the derived attempt directory showed `echo hyprscope-recovered` echoing successfully — showing that after recovery the injection helper accepts the renewed `planHash`.
- Choosing "Terminate": the run was `faulted`, `fault.step = 5`, `broken.detail` ended with `(host chose to terminate)`, `committed: [0,1,2,3]`, and there was no second attempt.
- Closing the target window directly during the pause: `faulted`, `broken.kind = target.missing`, **no** `interference.json` was written (non-restorable premises show no card), and `committed` was kept up to step 3.

Artifacts and lease state: the root run directory `out/runs/20261117T112526-ea7de0/` holds the first segment's `suspended.json`, `timeline.jsonl` (`step.suspend`, `run.suspended`, `run.resume`) and the aggregated `result.json` (`attempts: [suspended, completed]`); the derived attempt directory `out/runs/20261117T112528-c8286a/` has its own `plan.json` (with lineage and hash). In `state.json`, `rootPlanHash` kept the original plan hash, `planHash` switched to the derived plan hash, and `renewals` held one record with `attempt: 1` and `ttlMs: 34000`.

A note on the cancellation tests: consent in these three rounds of on-machine runs was recorded through the data plane rather than a real card click, and `grantedBy` recorded `cli`; the recovery flow where a real person clicks the card left no record this time, and the card's rendering and button logic were covered by the overlay's 52 assertions and interactive screenshots.

This round also closed a hole in event consumption: steps that skip preflight, such as `pause`/`waitEvent`/`screenshot`, used to advance the tap cursor to the current end, which swallowed the hard events that arrived before it (a new window opening, a window closing, a monitor change). These steps now check hard events once before they run, and `waitEvent` consumes only the single event it waited for and keeps the events after it. In practice: with a plan of three 1-second `pause` steps, opening a new window with `foot` during the first pause made the run `faulted` before the next pause, with `broken.kind = foreign-event` and `detail = external openwindow event`.

This round also removed the `ECHO_KINDS` echo attribution table: since whether a premise is violated is now judged by re-evaluating the declared premises, there is no need to infer our own side effects from events; events are left only for hard failures that no premise can explain, such as `openwindow`/`closewindow`/`monitor*`/`submap`.

Automated tests this round: all 149 in `pnpm test` passed (live tests for the observation layer and the control lease, the plan engine, the lease, recovery synthesis and derivation, the dispatch allowlist), `pnpm run typecheck` reported no errors, and `qmllint overlay/shell.qml` produced no output.

**Interference notice**: writing `notice.json` into the lease directory by hand (`leaseId` matching, 20-second expiry) made the banner turn into two lines within the 300ms poll and show an amber hint bar reading "External operation detected, recovering 1/2; press SUPER+ALT+Escape to revoke control"; screenshot `out/notice-banner.png`; after `panic` the overlay and the layer both disappeared.

**Automated tests (as of the third round)**: `pnpm test` had 111 tests then (70 live tests for the observation layer and the control lease + 17 for the plan engine + 24 for lease binding and records), and `pnpm run typecheck` reported no errors. The plan engine's tests use a fake world to cover completion, fault, repairable interference, revocation, postcondition failure, foreign-key event repair, waitEvent, region screenshots and key mapping; the real compositor was used only in the live tests and the manual verifications above.

## Capability baseline

Added after the fourth round; verified on the test machine on 2026-11-17.

**Build**: `pnpm run build:scratch` compiles `probe/wl-scratch.c` against the system `xdg-shell` protocol with `-Wall -Wextra` and no warnings, producing `bin/wl-scratch`; run standalone it maps a 320×200 floating window titled `hyprscope-scratch`, prints `{"event":"ready","width":320,"height":200}`, reports injected function keys as evdev keycodes, and exits cleanly on SIGTERM. It keeps fixed-size hints until SIGUSR1, which the probe sends before measuring a resize; without that a fixed-size toplevel cannot be resized and the read-back would be meaningless.

**Probe**: `hyprscope control baseline --probe` asked for the acceptance lease (consent card reason "installation acceptance: capability probe", plan hash `sha256("hyprscope-probe/1")` = `48dcf1a2…`, TTL 60 s), measured, wrote `out/baseline/<probeId>/{probe.jsonl,summary.json,capture.png,scratch.log}`, and released the lease. Three consecutive probes produced `state: usable`, 18 capabilities `supported/measured`, and only `dispatch.window.move-to-workspace` unknown (recorded, not gated). Measured round trips included: the pointer moved to the scratch centre `1305,720` and read back with delta `0,0`; `F12` received by the scratch client as evdev `88`, press and release; move read back exactly, resize read back `360×240`, float/pin/fullscreen set and cleared with read-back; `openwindow`/`closewindow` matched by address; cleanup restored the previous focus and workspace and left no scratch window or helper process; the lease ended `released` (`grantedBy: cli`).

**Acceptance and narrowing**: the acceptance wrote `baseline.json` (0600) with `approval {approvedBy: "human", source: "cli", evidenceSha256}` and a `revisions[kind: "accept"]` entry; `doctor` then reported `baseline: usable · approved … · hyprland 0.57.2`. A later probe whose effective set was a subset and whose evidence did not improve rewrote the accepted file in place, kept the approval, and appended `revisions[kind: "narrow"]`; anything wider (including `advertised → measured` for an effective capability) came back as a pending draft, and the next probe asked the host to confirm it.

**Gate**: with no baseline, `hyprscope control run --dry-run` failed with `CAPABILITY` and no consent card; with an `incomplete` baseline it listed exactly the unmeasured required capabilities (`observe.geometry`, `inject.pointer`, `inject.keyboard`, `events.socket`); after acceptance a one-step `pause` plan ran to `completed` and its report carried `baseline {state: usable, approvedAt, compositorVersion: "0.57.2", degraded: []}`.

**Defects found and fixed while verifying** (these really happened):

- The row matcher compared the spawned pid with `clients[].pid`. In this environment the child runs in a pid namespace, so the compositor reports a different pid and a real scratch window was discarded as "did not appear"; matching is now by app_id + title, requires exactly one row, and cross-checks the `openwindow` address.
- The event socket prints addresses without `0x` while client rows carry it; comparisons are normalized, which is why `closewindow` had been reported missing even though it was already buffered.
- The consent card hands focus back to the previous window while it closes, which raced the first focus dispatch: one probe read `activewindow` as the browser, stopped injecting, and recorded `inject.pointer`/`inject.keyboard` as unknown, narrowing the accepted baseline to `incomplete`. Focus is idempotent, so the probe now retries the dispatch up to three times; three consecutive probes after the fix were `usable`.
- A failed probe narrows the accepted baseline automatically (the safe direction). That is intended, but it means a timing race can disable control until the next successful probe; the retry above is the mitigation, and the revision trail (`accept, accept, narrow, accept`) shows exactly what happened.

Automated tests this round: `pnpm test` passed 181 tests (32 of them for the catalog, the baseline reader, the gate and acceptance, using fixed fixtures and no compositor), `pnpm run typecheck` reported no errors, and the bilingual pairing gate was green.

## Desktop and drift (2026-11-18)

The desktop and drift work was verified on the test machine on 2026-11-18, with Hyprland 0.57.2, the Lua provider and the `wayland` backend. This section records that run; it does not promise that another host's nested window, output size or config hash behaves the same way.

`hyprscope control desktop start` created a nested instance with signature `11cbc6c..._1794934801_1106711295` under the runtime root `/run/user/1000/hs`; the nested monitor was `WAYLAND-1` at 1228×1398. On the agent's desktop the probe reported `usable` with 17 supported and 0 unsupported capabilities and 2 unknown: `observe.window.modes` (no window was open) and `dispatch.window.move-to-workspace` (intentionally unmeasured). The user's probe reported `usable` with 18 supported, 0 unsupported and 1 unknown, again `dispatch.window.move-to-workspace`.

After the agent baseline was accepted, `doctor --desktop agent` reported `fresh`. Adding `config/hypr/agent/extra.lua` changed the observed config hash to `f0386a45...`; `doctor` then reported `stale` with difference `configHash`, and `hyprscope control run plans/live-terminal.json --dry-run --desktop agent` exited 1 with `CAPABILITY`. Removing the snippet restored `fresh`.

In a separate check, after the snippet edit, the probe guard was exercised against a generated config that differed from the recorded hash: `hyprscope control baseline --probe --desktop agent` exited 1 with `DESKTOP_FAILED` and the message `The desktop configuration changed since it started; stop and start the desktop before probing it`. The desktop was then stopped; it was not re-probed mid-configuration.

`hyprscope control run plans/live-terminal.json --desktop agent` completed 5 ops (`focusWindow`, `click`, `text`, `chord`, `screenshot`) with no consent card. The run receipt carried `target {kind: "agent", signature: "...", managed: true}` and the run directory was `out/runs/20261117T170106-5e8a83`; the captures were 1186×1356 and 1139×1220, the nested output rather than the user's 2560×1440. The per-desktop lease record ended `phase: released` with `grantedBy: desktop`.

Stopping the desktop 1.5 s into a `waitEvent` plan made the run `faulted` with `fault.broken.kind: target.desktop-closed`. While the nested desktop was running, `hyprscope doctor` and `doctor --desktop user` both resolved the user's signature, and `--desktop agent` resolved the nested one. `hyprscope control desktop attach --runtime-dir /run/user/1000 --signature <user signature>` exited 2 with `USAGE`.

The earlier user baseline had no effective fields; one probe auto-narrowed it and recorded `followMouse: "1"`, `binds {count: 163, plainF12: false}` and `configErrors: []`; `doctor` then reported `fresh`, and a user `run --dry-run` passed.

Automated checks this round: `pnpm test` passed 258 tests, and `pnpm run check` was green (11 document pairs, typecheck, tests).

## Unified CLI (2026-11-18)

The two entry points were merged into `bin/hyprscope.ts`; `bin/hyprlease.ts` no longer exists. Observation keeps the bare commands, and every command that can change the desktop or its lease sits under `hyprscope control`.

- `node bin/hyprscope.ts --help` lists the observation commands and one `control` line; `node bin/hyprscope.ts control --help` lists `run`, `request`, `status`, `done`, `panic`, `baseline`, `install-bind`, `uninstall-bind` and `desktop`.
- `node bin/hyprscope.ts run` exits 2 with `Unknown command run; control commands live under "hyprscope control run"`, so a missed namespace does not fall through to observation.
- `node bin/hyprscope.ts control status --json` read the lease record without a compositor, and `node bin/hyprscope.ts control desktop status --json` reported `absent` when no managed desktop was recorded.
- `pnpm run typecheck` and `pnpm test` passed: 264 tests, including the routing tests and a test that removes a legacy failsafe block.
- `node bin/hyprscope.ts control desktop start --size 900x700` started a nested instance, `control desktop status` reported every check true, the generated bind invoked `bin/hyprscope.ts control panic --desktop agent`, and `control desktop stop` removed the runtime root.
- The failsafe bind installed before the merge pointed at the deleted `bin/hyprlease.ts`. `hyprscope control uninstall-bind` recognises both marker generations, and `hyprscope control install-bind` writes a `hyprscope` command and description. The live user configuration was not rewritten in this round; reinstall the bind after merging.

## DSH plugin (2026-11-18)

The DSH plugin bundle was verified on the same test machine on 2026-11-18: Hyprland 0.57.2 with the Lua provider on the `wayland-1` display, runtime `/run/user/1000`, Node 26.13.1, and DSH 0.2.2-rc.3 installed at `/home/jw/.local/share/deepseek-harness` with the `web` profile.

**Installation**: `plugins/dsh-hyprscope-tools/` was installed into the profile with `plugin_manager` action `install_bundle`; the result was `application: applied`, the plugin row `include:hyprscope-tools` was `active`, and the live tool registry listed seven tools: `hyprscope_observe`, `hyprscope_screenshot`, `hyprscope_events`, `hyprscope_lease`, `hyprscope_plan`, `hyprscope_baseline` and `hyprscope_desktop`. The follow-up section below adds `hyprscope_act`, so the bundle now exposes eight.

**Live calls**: every call exercised was read-only or was refused before a consent card appeared:

- `hyprscope_observe` with `kind` set to `active`, `state` and `doctor` returned parsed results; the `doctor` render dropped `capabilities.wayland.globals`, and the `state` result stayed inside the render cap.
- `hyprscope_screenshot` with `scope: "region"` and `region {x: 0, y: 0, width: 480, height: 270}` produced a 480×270 PNG and attached the image to the result.
- `hyprscope_events` with `timeoutMs: 600` returned `{events: [], timedOut: true}`.
- `hyprscope_lease` action `status` read the released lease, and `hyprscope_desktop` action `status` read the closed agent-desktop record.
- `hyprscope_plan` action `validate` on `plans/live-terminal.json` and `hyprscope_lease` action `request` both failed with `CAPABILITY` before any consent card, because this machine has no accepted capability baseline; a deliberately invalid inline plan failed with `PLAN_INVALID`.

**Defect found by the first live run** (it really happened): the `hyprscope_events` render returned a bare string and failed with `content.some is not a function`; the render was fixed and re-verified after a profile recomposition.

**Not verified**: control execution (no baseline was accepted, so a plan `run` and a lease grant were never exercised), GUI rendering of the bundle's locale, icon and detail metadata, an image on a text-only model route (unit-tested only), and the agent-desktop lifecycle (`start`, `attach` and `stop` were not exercised live).

Automated checks this round: `node --test plugins/dsh-hyprscope-tools/test/` passed 59 tests with 0 failures; the repository suite passed 264 tests; `pnpm run typecheck` was clean; the bilingual pairing gate was green.

## Plan binding follow-up (2026-11-18)

Later on the same day the plan submission path was simplified, because a plan is submitted once and never resent: the canonical plan hash and the helper's `--plan` proof were removed.

- `hyprscope control run` also accepts `-` and reads the plan document from stdin (one JSON document, at most 1 MiB); a file path still works. The document is loaded and validated once, before the consent card, and the executor runs that in-memory plan.
- The lease records `planBound: true` and `planSummary` instead of `planHash`/`rootPlanHash`; each `renewals[]` entry is `{at, attempt, ttlMs, expiresAt}`. The executor's per-mutation check requires the same lease id, `planBound: true` and an unexpired TTL; the injection helper takes `--lease-state` + `--lease` and checks `planBound` rather than a digest.
- The DSH bundle sends an inline plan on stdin, writes no plan file, and exposes `hyprscope_act`, which runs one action as a one-step plan through the same run path.
- The reason the hash went away is that it never guarded against a mid-run file edit (the executor loads the plan once, before consent); what remained was audit convenience, which the canonical `plan.json` snapshot and the lease identity/attempt counters already cover.

Verified this round: `pnpm run typecheck` was clean; `pnpm test` passed 339 tests (272 repository + 67 bundle); `pnpm run build:inject` rebuilt `bin/wl-inject` with the new proof, and the rebuilt helper was run against the live session: an unbound lease, an expired lease and a consent-phase lease were all refused by the gate before any command was sent, and an unknown `--plan` argument is rejected. a hand-submitted `control run -` document was parsed and then refused with `CAPABILITY` (no accepted baseline), while malformed JSON, empty input and a missing argument reported `PLAN_INVALID` or the usage error as intended. The bilingual gate passed 12 pairs.

Not verified: the consent card → execution path under the new binding (this machine still has no accepted capability baseline), live injection under `planBound`, and `hyprscope_act` against a live run. The earlier sections of this record mention `planHash`; that field no longer exists.

## Consent surface: baseline acceptance and plan preview (2026-11-18)

The baseline's acceptance step and the plan preview moved onto the same consent card, so the baseline flow needs no terminal command and a plan is approved by reading what it does. The items the previous section left unverified — the consent card to execution path, injection under `planBound`, and a live `hyprscope_act` — are covered here.

- A probe whose measurement widens the accepted baseline asks the overlay for a confirmation card in the same command: the verdict, the required/optional capability counts and the evidence hash. A card that is denied or expires writes nothing and keeps the draft, and only another probe asks again. A confirmation lease record ends `released` / `denied` / `expired`, carries the card (`confirm` then; `card` + `approvalOnly` after the merge below), `ttlMs: 0` and `planBound: false`, starts no holder and never reaches `granted`, so neither the executor nor `wl-inject` can inject under it.
- A plan lease carries a card: the plan's description, its budget and one line per step (`2. click · 在 foot 窗口 内 (0.5, 0.6) 点击左键`), rendered from the validated plan by `src/plan/card.ts`; a plan longer than ten steps shows the first ten and a count of the rest. The one-line `plan · N steps · ops` preview survives only as the fallback for lease files written before this change. (The field was `planCard` at the time; the next section merges the two card fields into one.)
- The DSH bundle exposes the acceptance through `hyprscope_baseline` action `probe`: the same call measures and, when the result widens the baseline, asks the CLI to show the confirmation card; the tool never answers it.

Verified this round on the machine:

- Probe with acceptance, entirely by tool calls: `hyprscope_baseline` action `probe` measured `f1e1ac0e-…` (full, `usable`, 19 capabilities, 451 ms) and asked for the confirmation card in the same call; the host clicked Allow. `baseline.json` records `approval.source: "overlay"`, its `approvedAt`, and the same evidence hash the probe wrote (`dd7638165d7a…`); the draft `baseline.pending.json` was removed.
- The confirmation's lease record ended `phase: released`, `grantedBy: overlay`, `ttlMs: 0`, `planBound: false`, `holderPid: null` — an approval record, not a control window.
- `doctor` then reported `baseline {present: true, state: usable, staleness: fresh}` with no differences, and `hyprscope control run` stopped being refused with `CAPABILITY`.
- A one-step `hyprscope_act` (`movePointer` to `1280,720`) let the host click the plan card and completed in 16 ms; the receipt carried `baseline {state: usable, approvedAt, compositorVersion: 0.57.2}` and the run directory held `plan.json`, `result.json` and `timeline.jsonl`.
- The new plan card was exercised by a two-step inline plan (`movePointer` + `assert pointer.position`). The card showed `计划 pointer-check：…`, `共 2 步 · 预算 8 秒`, `1. movePointer · 移动指针到 (1280, 720)` and `2. assert · 校验 pointer.position`; the lease state carried that card with `planBound: true`; the run completed and the cursor read back exactly `1280,720`, so the assertion proved the injection landed instead of trusting the dispatch ack. No plan file was written under `/tmp`.

Not verified in that round: the probe's move onto a measure plan and the unification of the two cards landed later the same day and are recorded in the next section. Recovery and the interference prompt were not re-exercised here.

## Probe as a measure plan, and one consent card (2026-11-18)

The probe's desktop-changing measurements stopped being a second injector, and the two consent cards became one.

- Reading, not injecting: the read-only phase stays in `src/compat/probe.ts`; the probe builds an ordinary validated measure plan from the facts it already read (`src/compat/probeplan.ts`), shows it on its lease card, starts its own `bin/wl-scratch` window, signals `SIGUSR1` once so the client lifts its fixed 320×200 size hints, and submits the plan to the normal executor in an internal measure mode. `src/compat/behavior.ts` is gone; the executor is the only injector.
- Measure mode records instead of faulting: a step whose premise does not hold, whose dispatcher is rejected, or whose postcondition does not read back is recorded and the run continues; only a lost lease, the plan budget or a foreign desktop change stops it. Recovery never runs in this mode, and neither `hyprscope control run` nor a plan document can request it.
- The measure plan ran 16 steps against the scratch window only: idempotent workspace dispatch, focus, pointer move followed by a read-back assertion, F12 chord, float off/on, pin on/off, fullscreen on/off, resize, move, then the workspace and focus restore steps. All sixteen committed (`stage: done`); `probe.jsonl` recorded one fact per step, the scratch client's `ready` and key lines, the event-socket round trip and the post-run read-backs, and the evidence directory also holds the measure run's `plan.json`, `result.json` and `timeline.jsonl`.
- Measure mode's "record and continue" semantics were exercised by a real defect the first probe found: resizing a floating window after moving it makes the compositor keep the window centre, so the requested `(0,0)` read back as `(-20,-20)` and `dispatch.window.move` was recorded as unsupported. Because that only narrowed the effective set, the probe applied the narrower baseline itself (`diff.removed: ["dispatch.window.move"]`). The plan was reordered to resize before the final move; the next probe (`c8666874…`) read the scratch window back at exactly `(0,0,360,240)`, reported every measured capability supported with no warnings, and produced a draft that only widened the baseline.
- Because that draft added `dispatch.window.move`, it needed a fresh acceptance: the card was shown, the host clicked Allow, and `baseline.json` recorded `approval.source: "overlay"` with the evidence hash `6ca2096164f2…`. `doctor` then reported `baseline {state: usable, staleness: fresh}` with 18 effective capabilities, zero degraded and zero missing required.
- One consent card: `state.json` carries a single `card` field (title, lines, button labels) and `requestLease` is the single request path. A plan lease fills the card with the plan's description and steps; an approval-only request (`approvalOnly: true`, used by the acceptance card a widening probe shows) fills the same card with the facts of the act. The overlay renders one card, and the record rules stay: an approval keeps `ttlMs: 0` and `planBound: false`, ends `released` on allow, starts no holder and can never inject. The probe's lease shows the same plan card as any plan; the probe-specific card variant introduced earlier the same day was removed.
- The single card was checked on the real overlay. A plan consent card rendered title `Agent 请求执行计划`, the reason, `计划 card-check：…`, `共 2 步 · 预算 8 秒`, one line per step, `拒绝` / `允许操控` and the countdown; an approval-only card rendered title `hyprscope · 接受能力基线`, the verdict/count lines, `拒绝` / `允许并接受`, no TTL sentence. Both came from the same `card` field and the same overlay card (`out/verify-plan-card.png`, `out/verify-approval-card.png`). The cards were denied from the agent side after the screenshots, so nothing was approved and no baseline file changed.
- Observed effects the plan cannot assert: the injected F12 arrived at the scratch client (`keyPressed: true`), the event round trip saw `openwindow`, `closewindow` and `windowGone`, the scratch window was gone from `hyprctl clients` after the run, and the plan's last steps restored the workspace and focus it found. No scratch window or lease was left behind.
- Automated checks this round: `pnpm run typecheck` clean; `pnpm test` passed 386 tests (318 repository + 68 bundle), including `test/probe-plan.test.ts` (9), `test/measure.test.ts` (9) and `test/probe-derive.test.ts` (13); the bilingual gate passed 12 pairs.

Not verified here: a probe on a multi-monitor layout (the move destination is the layout origin and the pointer origin is the layout box), and the ambiguity path for two matching scratch windows. Recovery and the interference prompt were not re-exercised.

## Bundle rename and new artwork (2026-11-18)

The DSH bundle now carries the project's name, and its Plugins entry says what an agent can do with it.

- Renamed: directory `plugins/dsh-hyprscope/`, package `@local/dsh-hyprscope` (0.3.0), plugin row id `hyprscope`, module `name` export `dsh-hyprscope`. The old names were `plugins/dsh-hyprscope-tools/`, `@local/dsh-hyprscope-tools`, `hyprscope-tools` and `dsh-hyprscope-tools`; the paths in earlier sections of this record predate the rename.
- The Plugins page title is `Desktop observation and control` (`桌面观察与操控`), and the description names both halves of the capability: reading the Hyprland desktop (session, windows, screenshots, events), and changing windows, pointer or workspaces only through a plan the host approves.
- The eye icon was replaced by a screen with a pointer on it (`icon.svg`): the screen is the desktop the agent observes, the pointer is the action it takes; consent stays in the card, so the artwork needs no surveillance symbol.
- The `web` profile was updated with `plugin_manager`: `remove_bundle` on the old package name, then `install_bundle` on `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`. Both reported `application: applied`, and `list_bundles` now shows `@local/dsh-hyprscope` 0.3.0 (enabled, installed, row `hyprscope`, source the linked directory) with no old entry.
- Display metadata was read through DSH's own `readPluginMeta` with the profile's module base: `title` resolved to `{en: "Desktop observation and control", zh: "桌面观察与操控"}`, `description` to the matching pair, and `icon` to an `image/svg+xml` data URI with no diagnostic. The tool registry still lists the same eight `hyprscope_*` tools, so the rename changed no tool name.
- Automated checks: `pnpm test` passed 386 tests (318 repository + 68 bundle), `pnpm run typecheck` was clean, and the bilingual gate passed 12 pairs.

Not verified: how the Plugins page and Settings draw the new icon and locale text in the browser, because this session has no browser control; the SVG was rasterized outside DSH with `rsvg-convert` and checked at row and card sizes on light and dark backgrounds instead.

## Language, off-screen capture and doctor (2026-11-18)

The bilingual consent card, the plugin's language mapping, window capture of an off-screen window and the new doctor checks were verified on the same test machine on 2026-11-18: Hyprland 0.57.2 on `wayland-1`, active workspace 2, a `foot` window on workspace 1 and another `foot` window on workspace 4.

**CLI consent card in both languages.** The demo plan moved the pointer twice and paused, so an approval could not touch a window; the reason was `demonstrate the bilingual consent card`. The Chinese and English cards came from the same command with only the language option changed:

```bash
node bin/hyprscope.ts control run .tmp/lang-demo-plan.json --lang zh
node bin/hyprscope.ts control run .tmp/lang-demo-plan.json --lang en
```

- `--lang zh` rendered the Chinese card: title `Agent 请求执行计划`, the reason, `计划 lang-demo：move the pointer twice, then pause; nothing is clicked`, `共 3 步 · 预算 8 秒`, one line per step, `拒绝` / `允许操控` and the countdown.
- `--lang en` rendered the English card: title `Agent requests to run a plan`, the same reason, `Plan lang-demo: move the pointer twice, then pause; nothing is clicked`, `3 steps · budget 8 s`, one line per step, `Deny` / `Allow control` and the countdown.
- The waiting `state.json` carried that card verbatim — title, lines, `acceptLabel: "允许操控"`, `denyLabel: "拒绝"` — and after the host clicked Allow it recorded `grantedBy: "overlay"`; the lease ended `released` with `planBound: true` and `ttlMs: 28000`, and the run executed under that consent.
- The click continued the waiting call without spawning a CLI process: the overlay writes the answer file itself and the waiting tool records the decision and continues.
- The three demo runs completed all 3 steps in 324–332 ms (`out/runs/20261118T153417-2c3f0d`, `…-73dc5f`, `…-b52d83`); `state.json` from `…-b52d83` is the record quoted above.

**DSH plugin language mapping.** The plan tool was driven through the plugin's own handler with `language: "en"`:

```bash
node .tmp/dsh-plugin-driver.mjs
```

The driver calls `execute({ action: "run", planPath: ".tmp/lang-demo-plan.json", language: "en", consentSeconds: 60 })`; the plugin mapped the language to `--lang en` on the spawned CLI, the card rendered in English (`Agent requests to run a plan`, `Deny` / `Allow control`), and the call returned `RESULT {"runId":"20261118T153952-35bd94","status":"completed","steps":3,"fault":null}`. A second timed run while the same card was up (`out/runs/20261118T154048-2abedb`) also completed 3/3, in 334 ms.

**Off-screen window capture.** With workspace 2 active, `--window-id` captured a mapped `foot` window on workspace 1 and another on workspace 4:

```bash
node bin/hyprscope.ts screenshot --window-id 0x560360f3c380 --output .tmp/verify-window-ws1.png --json
node bin/hyprscope.ts screenshot --window-id 0x56035f695030 --output .tmp/verify-window-ws4.png --json
```

The workspace-1 capture was 2448×1378 with `source.scope: "window"` and `window {identifier: "180002d9", appId: "foot", title: "~/w/dsh-hyprscope"}`; the workspace-4 capture was 1228×1398 with `window {identifier: "180001c6", appId: "foot", title: "rclone mount OneDriv ~"}`. The Hyprland address was translated through `hyprctl clients` to the foreign-toplevel id, and each PNG carried the window's own size rather than the 2560×1440 output.

**New doctor checks.** `doctor` now reports an `environment` block and a `capture.window` limitation; both are additive to the existing fields:

```bash
node bin/hyprscope.ts doctor
node bin/hyprscope.ts doctor --json
```

- Overlay runtime: `quickshell at /usr/bin/quickshell (default)` — a PATH lookup that honours `HYPRSCOPE_QUICKSHELL`; doctor never starts the overlay or the binary.
- State directory: `/home/jw/.local/state/hyprscope (exists, not writable)` with a `state hint` naming `EROFS: read-only file system`. That is this agent's file sandbox, not the host: a fresh `XDG_STATE_HOME=$PWD/.tmp/state-probe` run reported `exists: false, writable: true, probe: …/.tmp/state-probe`, and the directory stayed empty afterwards, so the check creates nothing.
- `capture.window`: window capture also works for a mapped window on an inactive workspace or off-screen, and the PNG carries the window size, not the output size.
- Screenshot preflight: an explicit `--output` must point into an existing, writable directory. A missing directory and a `chmod 500` directory both failed with exit 1 and `SCREENSHOT_FAILED: Cannot write the capture: …; pass --output <writable path>`, while `XDG_CACHE_HOME=$PWD/.tmp/cache node bin/hyprscope.ts screenshot` still created the default `hyprscope` cache directory and wrote a 2560×1440 layout capture.

Automated checks this round: `node --test test/doctor.test.ts test/screenshot.test.ts test/cli.test.ts test/live.test.ts` passed 50 tests (11 + 17 + 14 + 8); the new live test read the doctor `environment` block from the running compositor and the existing live window-capture test captured an off-screen window. The pair was re-recorded with the bilingual pairing gate.

## Ambiguous window selectors and explicit capture output (2026-11-18)

Two `foot` windows were open, one on workspace 1 and one on workspace 4, with workspace 2 active. `--window-app foot` now refuses the ambiguity with one stable line per candidate instead of a bare count:

```bash
node bin/hyprscope.ts screenshot --window-app foot --output .tmp/ambiguous.png
```

The command exited 2 with `USAGE: 2 windows match this application id; use --window-id to pick one:` followed by the candidates ordered by workspace and then address: workspace 1 `0x560360f3c380` `foot` `title "~/w/dsh-hyprscope"` and workspace 4 `0x56035f695030` `foot` `title "rclone mount OneDriv ~"`, both marked `off-screen` because workspace 2 was active. `--json` carried the same ordered list in `details.candidates` plus `details.hint`, and `--window-title` duplicates take the same path (unit-tested with a fake compositor, because the two live `foot` titles differ).

An explicit `--output` in a missing directory now fails before the capture helper runs: `captureToplevel()` reuses the same `SCREENSHOT_FAILED` preflight as `capture()`, so `--window-id 180002d9 --output .tmp/no-dir/window.png` exited 1 with `Cannot write the capture: the capture directory does not exist; pass --output <writable path>` and created no directory. The default `$XDG_CACHE_HOME/hyprscope` path is still created for a layout capture.

Automated checks this round: `node --test test/window-selector.test.ts test/toplevel.test.ts test/screenshot.test.ts test/cli.test.ts test/live.test.ts` passed 53 tests (6 + 8 + 17 + 14 + 8), and `pnpm run typecheck` was clean. The pair was re-recorded with the bilingual pairing gate.

## Desktop messages, the hint and the shortcut (2026-11-19)

The desktop-message surface was exercised on the same machine (Hyprland 0.57.2, Quickshell 0.3.2, 2560×1440).

- Rendering: `quickshell -p overlay/message -n` with a fixture `status.json` painted the hint pill at the top-right (`hyprctl layers` reported `hyprscope-message-hint`); with no `shortcut.txt` the pill said "快捷键未安装" instead of naming an unbound key, and after writing `SUPER + ALT + M` into it the pill showed that key. Writing an `open.json` request made the composer appear in the centre with the text field focused. Screenshots: `out/hint-no-shortcut.png`, `out/message-hint.png`, `out/message-composer.png`. The live composer really held the keyboard: the input method delivered the operator's keystrokes into the text field while it was open, which is the intended exclusive focus and also the reason the surface hides on submit. A debug copy that called the same submit function wrote `{"id":"mwn831pa-ikeqko","text":"hello from the desktop composer","at":"…"}` into `outbox/msg-mwn831pa-ikeqko.json`, which is the document the plugin consumes.
- CLI: `node bin/hyprscope.ts message open --json --lang en` returned `{command, dir, overlay: {pid, log}, request, dsh}`, wrote `open.json`, and started the overlay with `WAYLAND_DISPLAY=wayland-1`, the real `XDG_RUNTIME_DIR` and the requested language; `message stop` wrote `quit.json`; `message overlay` without a compositor failed with `NO_SESSION`, and a missing Quickshell failed with `OVERLAY_FAILED`.
- Binds: `installBind` was exercised against a fake `hyprctl` only (both descriptions verified, the message key recorded in `shortcut.txt`, conflicts and equal keys refused). The real `~/.config/hypr/hyprland.lua` was not modified this round, so the two binds have no on-machine `hyprctl binds -j` entry yet.
- Plugin bridge: unit tests drove it through a fake Cordis context and a fake `bin/hyprscope.ts` and covered activation and status, start-up overlay retry, session tracking (root sessions only), composed-message consumption, screenshot attachment, `sessionController.prompt` injection, the text-only retry when the image is refused, error receipts and disposal. An overlay killed after a successful start, and the heartbeat's restart of it, were unit-tested with a fake CLI that reports a dead pid; they were not exercised by killing a live Quickshell. An injection into a genuinely running DSH Host was not run: the live Host predates this change and was not restarted, so the in-process `sessionController.prompt` call is established by its public method contract and the fake service, not by an on-machine message.

## Desktop annotation, push-to-talk and the intent card (2026-11-19)

The annotation surface and its bridge were added on the same day as the desktop-message surface. This section records the automated coverage of that change and states plainly what was not exercised; it is not a claim that the live desktop path works on another machine.

**Automated checks.** `pnpm test` passed all 540 tests with 0 failures and 0 skipped, covering the repository suite and the DSH bundle: contract validators, unit tests and one end-to-end fake-session integration case. `qmllint overlay/message/AnnotateSurface.qml overlay/message/shell.qml` produced no output.

- **Contract and state files** — `test/message.test.ts`: the annotate session identifier and path shape, validators that reject a wrong version or field type, the atomic read/write helpers, the legacy `open.json` shape versus `mode: "annotate"`, and the CLI's annotate success, unavailable-Host, `NO_SESSION` and `OVERLAY_FAILED` paths (the last two write no request).
- **Managed binds** — `test/lease.test.ts`: all three binds and their descriptions, the `--annotate-key` override, refusal of a taken or duplicated key, replacement of a managed block, rollback of the configuration and both shortcut records (and removal of the generated Lua file) after a failed reload or partial verification, and the complete uninstall.
- **Bridge and intent card** — `plugins/dsh-hyprscope/test/annotate.test.js`: monitor selection by pointer then focus, the intersecting-window list and its cap, the card's geometry, window, comment and speech-link lines, an unbound phrase as a global note, the missing-screenshot note and text bound, nonce and duplicate-request handling, and one full fake session that captures, transcribes and injects exactly one prompt.
- **Voice geometry** — `plugins/dsh-hyprscope/test/voice.test.js`: the canonical 44-byte RIFF/WAVE header, absolute-time PCM offsets and sample-aligned slicing, VAD phrase splitting with silence, padding and minimum length, and every linking rule including the 60% threshold, the anchor fallback and the 2-second sequence window.

**Not verified on a real desktop.** The installer was exercised against a fake `hyprctl` and a fake instance only, so the real `hyprctl binds -j` has no annotate entry yet and the three shortcuts were not pressed on the live compositor. The annotation overlay was not rendered or driven in a live Quickshell session: drawing, hold-Space recording, the review-card edits and the error cards are covered by unit tests and static QML checks, not by interaction. No microphone was recorded and no real SenseVoice transcription was run; the tests feed synthetic PCM and a fake `speechToText` service. No intent card was injected into a running DSH Host: the in-process `sessionController.prompt` call is established by its public method contract and a fake service, not by an on-machine message. After installing this checkout, restart DSH, run `hyprscope control install-bind`, and verify by hand that the annotation shortcut opens the frozen screen, a drawing plus a spoken phrase appear in the review card, and the resulting message reaches the conversation with a clean screenshot and the geometry card.

## Not covered

Multi-monitor, multiple Hyprland instances, multiple seats and behavior while the screen is locked have no on-machine entries in this record, and no cross-version comparison was done; the lease's ability to intercept physical input does not exist in the first place (see [LEASE.md](/docs/cli/LEASE.md)). Drawing any conclusion requires running again in the corresponding environment.
