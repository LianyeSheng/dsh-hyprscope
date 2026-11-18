# AGENTS.md — hyprscope collaboration rules

The repository is called hyprscope and exposes **one entry point**, with **the capability boundary between its observation commands and its `control` surface**:

| Surface | What it can do | What it must not do |
|---|---|---|
| `hyprscope <command>` | Read-only observation: discover the session, read windows/workspaces/monitors/layers, take screenshots, subscribe to events, run the doctor report | Change any desktop state; load the lease, executor, injection or desktop-lifecycle modules |
| `hyprscope control <command>` | Take over briefly after the host consents: lease, plan validation and execution, input injection, capability baseline, agent desktop | Bypass the lease; the injection helper re-verifies the lease proof itself |

`bin/hyprlease.ts` was removed; `bin/hyprscope.ts` is the only binary. The router in `src/entry.ts` dispatches to `src/lease/cli.ts` only when the first word is exactly `control`, and loads it dynamically. To decide which side a change belongs to, ask only whether it "changes the desktop". Both surfaces share session discovery, observation and protocol code under `src/`, but they do not share gating.

## Development environment

- Main language TypeScript; C/C++ only for the Hyprland/Wayland interface layer (`probe/wl-globals.c`, `tools/inject/wl-inject.c`).
- The package manager must be **pnpm**, never npm. Runtime Node >= 22; TypeScript is executed directly and there is no build step.
- Live integration tests (`test/live.test.ts`) skip automatically when no Hyprland session is found; do not mock the compositor to make them pass.
- In the sandbox `/run/user/1000` is read-only; point the install at a writable location:

```sh
TMPDIR=$PWD/.tmp XDG_RUNTIME_DIR=$PWD/.tmp pnpm --store-dir "$PWD/.pnpm-store" install
```

## Commands

| Scenario | Command |
|---|---|
| All tests (unit + live) | `pnpm test` |
| Full check (bilingual pairing + types + tests) | `pnpm run check` |
| Type check | `pnpm run typecheck` |
| Environment and capability report | `pnpm run doctor` |
| Build the Wayland probe | `pnpm run build:probe` |
| Build the injection helper | `pnpm run build:inject` |
| Validate/execute a plan | `node bin/hyprscope.ts control run <plan.json \| -> [--dry-run] [--max-resumes 0..3]` |
| Start/attach/stop the agent desktop | `node bin/hyprscope.ts control desktop start\|attach\|status\|stop` |
| Run the CLI directly | `node bin/hyprscope.ts <command>` / `node bin/hyprscope.ts control <command>` |

## Read-only surface (`hyprscope ...`)

- `src/cli.ts` must not statically import `src/lease/`, `src/plan/`, `src/control/`, `src/inject/` or `src/desktop/lifecycle.ts`. The only desktop imports it may keep are `src/desktop/hash.ts` and `src/desktop/target.ts`. The router `src/entry.ts` is the single place allowed to load `src/lease/cli.ts`, and only after the literal word `control`.
- `hyprctl` goes only through the allowlist in `src/hyprctl.ts`. Never add `dispatch`, `keyword`, `eval`, `repl`, `kill`, `reload`, `setprop`, `output`, `plugin`, `setcursor`, `seterror`, `notify`, `dismissnotify`, `hyprpaper` or `hyprsunset`.
- The only mutating `hyprctl` call is `hyprctl reload` in `src/lease/bind.ts` (installing or removing the failsafe shortcut). Do not move it, and do not add `reload` to the allowlist.
- External commands must use `execFile` with argv arrays, never a shell; new external commands need a timeout and an output cap.
- Screenshots are refused by default when the session reports locked; do not turn that default into an allow.
- Before adding a capability that injects input or changes windows or workspaces, update the capability declaration in `docs/PROTOCOL.md`, then write the code.

## Control surface (`hyprscope control ...`)

- Control commands live only under `control`; do not add top-level aliases. Keep the first-word match in `src/entry.ts` exact, and keep `src/lease/cli.ts` dynamically imported. The overlay, the lease holder and the failsafe bind invoke `hyprscope control ...`; keep `HYPRSCOPE_BIN`/`HYPRSCOPE_NODE` in sync.
- `hyprscope control run` reads its plan document exactly once — from a file, or from stdin with `run -` — and executes the validated in-memory plan. Do not re-read the plan source mid-run, do not write the plan to disk on the way in, and do not reintroduce a plan hash or credential binding: the lease records `planBound` and `planSummary`, and the executor and `wl-inject` check that binding, not a digest. The consent card shows the plan's description and one line per step (`card`, rendered by `src/plan/card.ts` from the validated plan; the same card type carries approval-only requests); it is derived, never authored separately, and it describes only catalog ops.
- Single-step operations are one-step plans. A convenience wrapper may synthesize `{version: 1, id, reason, steps: [step]}` and submit it through the normal run path, but it must not add a second execution path, new ops, or implicitly generated `requires`/`expect`.
- Any action that changes the desktop must first obtain a lease; never bypass it with a direct `hyprctl dispatch`/`eval`. The contract is `docs/LEASE.md`. The desktop lifecycle commands (`desktop start|attach|stop`) are not desktop mutations; see the agent-desktop section.
- The test machine's Hyprland uses the Lua config provider: `hyprctl dispatch` arguments are evaluated as Lua, so classic string dispatchers do not work. Allowed expressions may only be assembled from whitelist templates in `src/control/dispatch.ts`, with variables validated first; never accept caller-supplied Lua fragments.
- `bin/wl-inject` must be started with a lease proof (`--lease-state/--lease`): the helper re-reads state itself and refuses to inject during `consent` or when the lease is not bound to a submitted plan. Do not add a "skip the gate" switch, and do not make the lease proof optional for callers.
- The plan executor is the only injector. `PREDICATE_SPECS`, `OP_SPECS` and the violation policy in `src/plan/model.ts` are code constants: changes must update `docs/PLAN.md`, and plan authors may never add kinds or change severity.
- A state-changing op generally must declare `requires` (`movePointer` and `workspace` are exceptions); a non-idempotent op must also declare `expect`; the executor re-reads the lease and requires the same lease id, `planBound: true` and an unexpired TTL before every mutating call, and this path must not be bypassed.
- Recoverable premises are restored only through a derived plan, never patched in place: first publish `interference.json` to ask the host, and only on `continue` does the executor suspend the attempt and derive a recovery plan. Do not add an "auto recovery" switch or a default consent. A prompt that times out counts as `abort`; replies are validated by `id`. Inside an `agent` or `external` desktop the overlay does not exist, so a restorable conflict faults instead of prompting; the agent asks the user in the conversation.
- The tool synthesizes restore steps from the `restore` templates in `PREDICATE_SPECS` (`src/plan/recover.ts`); plan authors may not write restore steps. A derived plan's `lineage` may only be produced by the tool; an external plan carrying `lineage` must be rejected.
- A recovery attempt may not recover again (`resumeAllowed` is true only for the first attempt); a non-recoverable premise (closed window, changed monitor, changed capture region, ...) faults immediately and hands the facts back for replanning.
- Lease renewal goes only through `renewLease`: same `leaseId`, `attempt` exactly plus one, at most `maxResumes`, total TTL within `totalBudgetMs`. Do not let the executor edit `state.json` itself.
- A recovery attempt follows the same requires/expect, per-call lease gating and dispatch allowlist.
- `out/runs/` holds run artifacts (plan snapshot, timeline, screenshots, `suspended.json`, fault); it is gitignored and must not be edited by hand.

## Why one entry point, two surfaces

- Read-only stays safe by default: the bare commands have no route to control code, and `control` must be the literal first word. The router is one exact comparison; do not replace it with prefix matching or a table that could send `doctor` down the control path.
- Merging the binary removed no gate: `wl-inject` still verifies the lease proof, the executor still re-reads the lease and its plan binding, the overlay is still the consent surface, and the probe still obtains its own lease. Keep all of that.
- DSH's CUA provider can still expose read-only methods unconditionally; `getCapabilities().action` is non-empty only when the control surface is available.
- `bin/hyprlease.ts` stays deleted. Do not reintroduce an alias, and do not attach control commands to the top level. If compatibility ever needs the old name, it must be a shim that invokes `hyprscope control`, not a second implementation.
- The old failsafe marker (`hyprlease failsafe`) is accepted only for migration; new installs write `hyprscope` markers and commands. Do not delete the legacy-marker branch without a migration plan.

## Capability baseline

- Control requires an accepted baseline. `hyprscope control run` (including `--dry-run`) and `hyprscope control request` read the baseline for the selected desktop (user: `$XDG_STATE_HOME/hyprscope/baseline.json`, draft `baseline.pending.json`; managed: `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`, draft `<signature>.pending.json`) and refuse with `CAPABILITY` before any consent card when it is missing, still a draft, `incomplete`, stale or unverified; read-only `hyprscope` is unaffected. Do not add a control path that skips this gate.
- The catalog is code: capability ids, levels and the `requires` of every predicate, op and restore template live in `src/compat/catalog.ts` and `src/plan/model.ts`. The baseline can only subtract. An id the baseline names but the code does not know is ignored with a warning; a missing id is unknown; `supported` with `advertised` evidence never satisfies a required capability.
- Only `hyprscope control baseline` writes the file. `--probe` measures and writes a draft (evidence under `out/baseline/<probeId>/`); `--accept` is the human act and asks for a confirmation card through the overlay — a card that is denied or expires writes nothing and keeps the draft; a probe that only narrows applies itself and appends a revision, and anything wider needs a fresh acceptance. The agent may run the probe, explain the evidence and trigger the confirmation card; it may never answer that card, hand-edit the baseline, relabel a failure as `unknown`, or skip a required item.
- The probe measures through the plan executor's internal measure mode; the executor is the only injector. The read-only phase stays in `src/compat/probe.ts` (hyprctl reads, registry globals, helper inspection, failsafe bind, region capture, fingerprint, session lock); every desktop-changing measurement is an ordinary catalog-op step in a measure plan built by `src/compat/probeplan.ts` and executed by `executePlan` in `src/plan/executor.ts` under the probe's own lease. The plan targets only the probe's own `bin/wl-scratch` window, through the symbolic `app`/`title` selector `hyprscope-scratch`, and its steps carry `requires`/`expect` like any plan. It is built before the lease is requested, from facts the read-only phase already measured (active workspace name, layout origin, pre-existing active window), so the probe's lease card shows the same plan preview as any consent card, and the lease stays `planBound`.
- Measure mode records instead of faulting: a step whose premise does not hold, whose dispatcher is rejected, or whose postcondition does not read back is recorded and execution continues, and those records are the evidence for the affected capabilities. Only safety failures stop the run — a lost or revoked lease, the plan's time budget, or a foreign desktop change; no recovery, suspension or interference prompt ever runs in measure mode. The mode is internal-only: `runPlanFile` never sets it and validation has no field for it, so neither `hyprscope control run` nor a plan document can request it. The probe holds its own lease and still re-checks it before every mutation. Do not add a bypass, a "measure without consent" flag, or a path that targets a user window.
- After the lease is approved the probe starts the scratch client, waits for it to map, and signals `SIGUSR1` once so the client lifts its fixed 320×200 size hints before the measure plan runs; the plan therefore targets only that window, and the resize round trip is real. After the plan the probe reads the scratch window's geometry back (the move and resize dispatches landed) and reads the scratch client's own stdout (the injected F12 arrived); these are observations, not injections.
- Capability evidence lives in the probe's evidence directory: `probe.jsonl` records the read-only facts, the measure plan, every step's outcome and the scratch client's output, beside the measure run's own artifacts (plan snapshot and timeline). The probe script identifier is `hyprscope-probe/2`.
- Runs never write the baseline. Recovery consults the effective set: `restorability()` refuses a restore template the baseline does not grant, the derived plan is re-checked against the fixed baseline before the lease is renewed, and such a violation faults the attempt with `recovery.capability`. `window.geometry` recovery needs both `dispatch.window.move` and `dispatch.window.resize`.
- `doctor` reports the baseline summary (state, approval time, missing degraded/required capabilities), the resolved `target`, and the `fresh`/`stale`/`unverified` verdict with reasons and differences; it stays read-only: no probe, no writes.
- Drift and staleness are implemented in `src/compat/staleness.ts` and specified in `docs/COMPATIBILITY.md` §5.1 and `docs/BASELINE.md` §3/§6: compare the recorded version, provider, `input:follow_mouse`, bind count/plain F12, configuration errors as a set, and `configHash` when recorded. `hyprscope control run` (including `--dry-run`) and `hyprscope control request` refuse a stale or unverified baseline with `CAPABILITY` before any consent card. A baseline without `effective` is `unverified` until re-probed; editing a generated desktop's snippet makes it stale, and the desktop must be stopped and started before it can be probed again.
- A `hyprctl dispatch` that returns no error only proves the Lua expression was accepted; it is never evidence that the effect happened. Effects are established by re-reading state (`expect` predicates and probe read-backs), and a plan never treats an ack as a committed step.

## Agent desktop

- `hyprscope control desktop start|attach|status|stop` are lifecycle commands, not desktop mutations. `start` may only spawn its own nested compositor; it must never move, focus or close a user window. `attach` only records an instance the user named, and `stop` kills only the agent desktop's process group or forgets an external record.
- `--desktop user|agent|external` is accepted by `hyprscope` commands and by `hyprscope control run/request/status/done/panic/baseline`; omitted means `user`. The default `user` resolution excludes the signature recorded in `desktop.json`, so a running managed desktop can never silently become the user's desktop; an explicit `--signature` still wins. Never silently retarget a command.
- Inside `agent` or `external`, every run and probe still obtains a lease, but programmatically and only under the consent recorded by `desktop start`/`desktop attach`; the user target always keeps the per-run card. Do not add a programmatic path for `user`, and do not bypass the executor's lease gate or the helper's lease proof.
- Per-instance state: baseline `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json` (draft `<signature>.pending.json`), lease `$XDG_STATE_HOME/hyprlease/<signature>/`; the internal `HYPRSCOPE_LEASE_SIGNATURE` selects the lease directory. The user's desktop keeps the machine-wide baseline and `hyprlease/`.
- `src/cli.ts` may import only the read-only `src/desktop/hash.ts` and the target resolver it needs for `--desktop`; never the desktop config or lifecycle control paths. Only `src/entry.ts` may load `src/lease/cli.ts`, and only dynamically under `control`.
- A plan whose agent/external desktop disappears faults with `target.desktop-closed`; a closed desktop is never restarted automatically. `desktop stop` releases that desktop's lease.

## DSH plugin

- `plugins/dsh-hyprscope/` is a Host-only DeepSeek Harness bundle that exposes `hyprscope_*` tools. It exists so a DSH agent calls tools instead of composing shell commands; the CLI stays the only implementation, and the plugin is a thin wrapper over `node bin/hyprscope.ts ... --json`.
- The wrapper must keep the two-surface boundary: it spawns the CLI with `execFile` and an argv array (never a shell), passes `--json`, sets a timeout and an output cap per call, and forwards caller cancellation. It must not import `src/` (not even dynamically), call `hyprctl`, or reach past the CLI into lease, executor, injection or desktop-lifecycle code. Read-only tools map to the bare commands only. An inline plan travels to the CLI on stdin (`control run -`): the bundle writes no plan file. A single-step convenience tool is a one-step-plan wrapper, never a separate action implementation.
- The plugin adds no gate and no bypass: control tools call `hyprscope control request|run|status|done|panic|baseline|desktop` and inherit the lease, plan-binding and capability-baseline gates exactly as the CLI enforces them. `baseline --accept` is the host's click on a confirmation card, so it is exposed as the baseline tool's `accept` action; the tool only asks the CLI to show that card, never answers it, and no other tool may pass `--accept`. Screenshots keep the locked refusal and `--allow-locked` is only passed when the caller asks for it.
- The bundle ships no `.md` file, which keeps it out of the bilingual pairing gate; user documentation is the `docs/DSH-PLUGIN.md` pair. Do not put a README inside the bundle without pairing it.
- Plugin unit tests live in `plugins/dsh-hyprscope/test/` and run as part of `pnpm test`; a live run of the plugin's tools belongs in the normal verification record, not in README.

## Documents and artifacts

- Documents are bilingual pairs: `foo.md` (English) + `foo.zh.md` (Chinese) + `foo.i18n.yaml` (consistency record). Any edit to one document must change both sides, then re-record with `python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>` and run the gate without arguments. Only the bilingual contract is installed; se-tools' decision workflow is not.
- `README.md` is for humans: quick start, the single entry point and its `control` surface, known limitations. **Do not put verification records in README**; they belong in `docs/VERIFICATION.md`. README holds only the project introduction and a short development guide.
- `docs/PROTOCOL.md` is the field-level observation contract. Changing a field means changing README, `docs/PROTOCOL.md` and the matching tests together.
- `docs/PLAN.md` covers the plan language, execution, recovery and the fault record; `docs/LEASE.md` covers the lease protocol and its boundaries.
- `docs/VERIFICATION.md` is a record of one real-machine verification, not an ongoing guarantee; re-verify after a machine change, an upgrade or a config change.
- `docs/COMPATIBILITY.md` and `docs/BASELINE.md` are the capability baseline's rationale and file contract; the code is `src/compat/`.
- `docs/DESKTOP.md` is the design contract for an agent-dedicated desktop (`hyprscope control desktop`, `--desktop`); the code is `src/desktop/`, and `desktop.json` is its record.
- `out/`, `bin/wl-globals`, `bin/wl-inject`, `bin/wl-scratch`, `tools/inject/generated/` and `tools/scratch/generated/` are verification or build artifacts, already gitignored; do not maintain them by hand.

<!-- se-tools:begin component=bilingual-docs -->
## Bilingual documents

When this repository keeps bilingual documents, every in-scope document is three sibling files: `foo.md` (English), `foo.zh.md` (Chinese) and `foo.i18n.yaml` (the consistency record). Update both sides in the same change and re-record the pair; apply one update as a minimal patch to the counterpart, never as a full re-translation. For understanding or reviewing a document, the English side is enough — do not read the Chinese counterpart alongside it.

Scope, exclusions and the record format are defined by [the bilingual contract](/.agents/se/contracts/i18n/README.md); translation rules are in [translation-rules.md](/.agents/se/contracts/i18n/translation-rules.md) and terms in [terminology.md](/.agents/se/contracts/i18n/terminology.md). Re-record and check a pair with:

```bash
python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>
python3 .agents/se/scripts/docs/verify_translation_pairing.py
```

The pairing gate runs on Python 3 with the standard library, and it makes the adopting repository pair its own in-scope documents; without it the rest of the workflow and the other gates still run. The extended [update-bilingual-docs](/.agents/skills/update-bilingual-docs/SKILL.md) workflow runs only when the user explicitly asks for it.
<!-- se-tools:end component=bilingual-docs -->
