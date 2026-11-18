# Compatibility and the capability baseline

English | [中文](/docs/COMPATIBILITY.zh.md)

> Status: **implemented**. `src/compat/` owns the capability catalog, the baseline reader, the effective-set rules and the staleness comparison; `src/compat/probe.ts` measures this machine, `hyprscope control baseline --probe/--show/--accept` is the command surface (accept asks for a confirmation card), and `doctor` reports the baseline summary and the staleness verdict. The probe's read-only phase stays in `src/compat/probe.ts`; every desktop-changing measurement is a step in a measure plan built by `src/compat/probeplan.ts` and run by the ordinary plan executor in an internal measure mode, under the probe's own lease and the same injection gate. This document explains why that installation step exists and what it must guarantee.

The numbers verified on the test machine (Hyprland 0.57.2, Lua configuration, a single `wl_seat`, a single 2560×1440 output) hold only for that test machine, as the opening of [VERIFICATION.md](/docs/VERIFICATION.md) already states. This document turns that sentence into an installation step: **measure once, record it, let a human confirm it, and narrow capabilities at run time against it**.

## 1. Three things that change

| Layer | Example | Ownership |
|---|---|---|
| Machine capability | Whether `hl.dsp.window.fullscreen_state` exists, whether absolute injection lands accurately, whether `.socket2.sock` exists, what the `clients[].fullscreenClient` field is called | Measured once at install time, goes into the capability baseline |
| Runtime state | Whether this window is floating now, which workspace it is on, where focus is, where the pointer is | Read live on every run, **never** goes into the baseline |
| Application behavior | A click does nothing, the window closes and the state is gone, the application ignores activate | Not measurable, not recoverable; fault directly |

Whether a plan can run is the intersection of the three, but the baseline owns only the first layer. Packing the latter two into the baseline would be an over-promise: "machine capability ✓" does not equal "all these premises can be restored".

## 2. Names and roles

| Word | What it is | Who produces it | Who can change it |
|---|---|---|---|
| Probe | One measurement: read the interfaces, run one measure plan on its own scratch client, record raw evidence | The tool, a script fixed in code | Code only |
| Capability baseline | A per-machine verdict file: which capabilities are supported, evidence levels, environment fingerprint, approver | Written as a draft by the probe | Only a human may approve |
| Acceptance | A human approves this baseline after reviewing the evidence and the diff | The human | — |

Why it is not called a checklist: a checklist implies static, manually ticked, and allowed once ticked. None of the three holds — the verdict comes from measurement, drifts with the environment, and can only narrow, never allow.

**Acceptance consent and plan consent are two different things.** The former says "this machine has these capabilities and the evidence is here"; the latter says "you are allowed to touch the desktop this time". They cannot reuse the same card, and a completed acceptance cannot waive plan consent.

## 3. Capability catalog

Each capability has: an id, a level, a detection method, and a consequence when missing.

### 3.1 Levels

| Level | Meaning | Consequence when missing |
|---|---|---|
| `required` | The foundation control rests on | Control is entirely unavailable, `hyprscope control run` rejects at validation time; read-only observation is unaffected |
| `degraded` | Control is possible, but one safety path is missing | Must be stated in the baseline, the receipt, and `doctor` |
| `optional` | Only the corresponding predicates/ops depend on it | Plans that use it are rejected at validation time, other plans run as usual |

### 3.2 required

| id | What it checks | Where the evidence comes from | What happens when missing |
|---|---|---|---|
| `observe.hyprctl` | `version`, `status`, `clients`, `monitors`, `workspaces`, `layers`, `activewindow` all return parseable JSON | Pure reads, `measured` | The observation layer stops working, acceptance fails outright |
| `observe.geometry` | `clients[].at` / `size` exist, are integers, and fall within the layout spanned by `monitors[]`; when `dispatch.window.move` is available, the measure plan moves the scratch window once and the probe reads it back to compare, confirming it is the same coordinate system (`at`/`size` are the raw `hyprctl -j` field names, called `position`/`size` in the normalized contract) | Existence + round trip, `measured` | The `window.geometry` predicate and geometry recovery stop working |
| `observe.cursor` | `cursorpos` returns `{x, y}` | Pure reads, `measured` | The `pointer.position` predicate and pointer recovery stop working |
| `dispatch.lua` | `status.configProvider === "lua"`, and the workspace round trip in the measure plan (re-activating the workspace the read-only phase read first) is accepted and returns neither `error:` nor `warning:` | The workspace round trip in the measure plan, `measured` | The whole dispatch subset fails (`hyprlang` is a different syntax), control is unavailable |
| `inject.pointer` | `wl-inject --probe` reports `zwlr_virtual_pointer_manager_v1`, and a `movePointer` step in the measure plan lands within the default tolerance of `pointer.position` (2 px) of a known layout coordinate inside the scratch client and reads back through `cursorpos` | Protocol existence + round trip, `measured` | Pointer injection is unavailable, or the absolute landing point cannot be trusted |
| `inject.keyboard` | `--probe` reports `zwp_virtual_keyboard_manager_v1`, and the scratch client receives the `F12` the measure plan injects (the helper key table has `F1`–`F12`; there is no more obscure F13); the probe confirms delivery from the scratch client's stdout | Protocol existence + round trip, `measured` | Keyboard injection is unavailable, and steps such as `text` / `chord` fail with it |
| `events.socket` | `.socket2.sock` is connectable; opening and closing the scratch client yields `openwindow` / `closewindow` | Round trip, `measured` | External interference detection and `waitEvent` stop working; **without it, no takeover** |

`required` capabilities always require `measured`: advertising a protocol does not mean the compositor actually honors it (the `exact` field episode was exactly "looks present, actually ignored"). When only `advertised` is available, record `unknown` — the interface exists but the semantics are unverified, so it does not count as `supported`.

### 3.3 degraded

| id | What it checks | What happens when missing |
|---|---|---|
| `safety.failsafe-bind` | The Lua entry configuration exists and is readable, and a binding with descriptive text is visible in `hyprctl binds -j` | One hand-back path is missing; the TTL, `done`, and the banner button remain, so it does not count as `required` |

Note that during probing this item is **read-only verification only**: it does not write configuration, install the shortcut, or run `hyprctl reload`. Whether reload can succeed is known only to `hyprscope control install-bind` itself: it checks that `~/.config/hypr/hyprland.lua` exists and is readable (with no additional config provider check), and restores the configuration when the configuration reports an error or the binding does not appear in `hyprctl binds`; but the branch where `hyprctl reload` itself throws does not restore, which is a known gap.

### 3.4 optional

| id | Affected predicates / ops / restore templates |
|---|---|
| `dispatch.focus.window` | op `focusWindow`; predicate `window.focused`; restore template `focus` |
| `dispatch.focus.workspace` | op `workspace`; predicate `workspace.active`; restore template `workspace` |
| `dispatch.window.move` | op `moveWindow`; restore template `geometry` (the move half) |
| `dispatch.window.resize` | op `resizeWindow`; restore template `geometry` (the resize half) |
| `dispatch.window.float` | op `floatWindow` (`floating`); restore template `state` |
| `dispatch.window.pin` | op `floatWindow` (`pinned`); restore template `state` |
| `dispatch.window.fullscreen-state` | op `fullscreenWindow`; restore template `state` (the fullscreen half) |
| `observe.window.modes` | The numeric fields `fullscreen` / `fullscreenClient` that the `window.state` predicate depends on |
| `capture.grim` | op `screenshot`; predicates `region.unchanged` / `region.changed` |
| `observe.lock` | The `lock` field in the `hyprscope state` snapshot (the lean snapshot the executor uses does not have it, and no predicate or op depends on it; for the record; best effort, `null` does not mean unlocked) |
| `dispatch.window.move-to-workspace` | Only a dispatcher, no corresponding plan op; for the record, not gated |

Geometry recovery needs both `dispatch.window.move` and `dispatch.window.resize`: when only moving works and resizing does not, the whole class of `geometry` recovery is treated as unavailable, rather than recovering only half of it.

### 3.5 Evidence levels

| Level | Meaning | Can it support `required` |
|---|---|---|
| `measured` | The tool did a round trip: sent the action, read the state back, and compared it against the expectation | Yes |
| `advertised` | Only the interface, field, or protocol global was seen to exist; the semantics were not verified | No; `optional` and `degraded` may record it as `supported` |
| `unknown` | Not measured, not measurable, or the probe was interrupted | No |

The verdict has only three states: `supported` / `unsupported` / `unknown`. `unknown` is always treated as unavailable, with no optimistic inference.

## 4. The probe

### 4.1 Read-only phase

No side effects; run first:

1. Read everything with `hyprctl -j` once and check whether those fields in §3.2 are present;
2. If `bin/wl-globals` is compiled (`pnpm run build:probe`), take the registry global list;
3. If `bin/wl-inject` is compiled, run `wl-inject --probe` and take the seat count and the existence of the two managers;
4. Do the read-only verification of `safety.failsafe-bind`;
5. Record the environment fingerprint and the session lock state;
6. Take one region capture (`capture.grim`); a screenshot mutates nothing.

The read-only phase can support `measured` for the `observe.*` items that need only reads; everything that needs a round trip is measured by the measure plan together with the probe's own scratch-client lifecycle.

### 4.2 The measure plan

It touches the desktop, so it needs a lease, and is **not a bypass**:

- `hyprscope control baseline --probe` builds the measure plan before requesting the lease, from facts the read-only phase already measured — the active workspace name, the layout origin, and the pre-existing active window. The plan is a normal validated document: it targets only the probe's own `bin/wl-scratch` window through the symbolic `app`/`title` selector `hyprscope-scratch`, and its steps are ordinary catalog ops (`workspace`, `focusWindow`, `movePointer`, `assert`, `chord`, `floatWindow`, `fullscreenWindow`, `moveWindow`, `resizeWindow`) carrying `requires`/`expect`;
- The probe then goes through `requestLease` itself (reason "installation acceptance: capability probe", `planBound: true` marks it as a plan-shaped consent, `planSummary` states that this is acceptance, TTL no more than 60 s, `maxResumes` 0). Because the measure plan is an ordinary plan, the consent card shows the same preview as any plan card — the description plus one line per step — under a probe-specific card title. This consent card approves "allowing the probe to temporarily take over the desktop for measurement", **not** approving the baseline itself; the baseline must be approved separately after the evidence is available (§9);
- After approval the probe starts the built-in scratch client (`probe/wl-scratch.c`, artifact `bin/wl-scratch`, built by `pnpm run build:scratch`), waits for it to map, signals it `SIGUSR1` once so it lifts its fixed 320×200 size hints (making the resize round trip real), and executes the measure plan through `executePlan` in its internal measure mode;
- A step whose declared premise does not hold, whose dispatcher is rejected, or whose postcondition does not read back is recorded and execution continues; those records are the measurement evidence and decide `unsupported` or `unknown` for the affected capabilities. Only safety failures stop the run: a lost or revoked lease, the plan's time budget, or a foreign desktop change. Measure mode never recovers, never suspends, and never shows an interference prompt;
- A `hyprctl dispatch` result other than an error only proves the expression was accepted, never that the effect happened; a dispatch is evidence only when the effect reads back. The plan therefore declares its `expect` predicates, so a window op (`floatWindow`, `fullscreenWindow`, `moveWindow`, `resizeWindow`) counts only when its dispatcher accepted the call and the state reads back; after the run the probe reads the scratch window's geometry back (the move and resize dispatches landed) and reads the scratch client's stdout (the injected `F12` arrived). These are observations, not injections;
- Finish: close the scratch client and check that no windows or processes are left behind;
- Budget 60 s; a plan time-budget hit or timeout is treated as "not measured"; artifacts go to `out/baseline/<probeId>/`: `probe.jsonl` (the read-only facts, the measure plan, every step's outcome, the scratch client's output), `summary.json` (the verdict draft), `capture.png`, and the measure run's own artifacts (plan snapshot and timeline).

### 4.3 What the probe does not do

- It does not touch user windows, only its own scratch client;
- It does not install or remove shortcuts, and does not change configuration (`safety.failsafe-bind` is read-only verification);
- It does not execute author-written plans and does not read user input; the only plan it runs is the measure plan the tool builds itself;
- It does not clean up the user's desktop, only what it opened itself.

### 4.4 Without a scratch client

Only the read-only phase runs: `observe.*` can still be `measured` from pure reads, while `dispatch.lua`, `inject.pointer`, `inject.keyboard`, and `events.socket` need the measure plan and the scratch client, so they can only reach `advertised` and are recorded as `unknown`. As long as one `required` capability has not reached `measured`, the baseline is `incomplete` (§5) and control stays off. This strictness is deliberate: better to be unusable than to click the user's interface with unverified semantics.

### 4.5 Measure mode is internal-only

This is now a rule, not a direction: AGENTS.md records it and the code enforces it. The executor is the only injector, and the probe reaches the desktop only through its internal measure mode. The mode is not part of the plan language: `runPlanFile` never sets it and validation has no field for it, so neither `hyprscope control run` nor a plan document can request it. The probe runs a fixed code path under `hyprscope control baseline --probe`; it holds its own lease, re-checks it before every mutation, and targets only its own scratch client through the measure plan. Do not add a bypass, a "measure without consent" flag, or a path that targets a user window. `--read-only` is not a bypass either: it sends no dispatch, runs no measure plan, and the resulting baseline is `incomplete` because required capabilities cannot be measured that way.

## 5. The effective capability set

```
effective(cap) =
     code declares cap                               # code is the upper bound
  && baseline.status(cap) === 'supported'
  && evidence(cap) !== 'unknown'                     # supported + unknown is treated as unknown
  && (level(cap) !== 'required' || evidence(cap) === 'measured')
```

- **Direction**: code is the upper bound, the baseline can only subtract. An id in the baseline that the code does not know → ignore and warn; an id missing from the baseline → treat as `unknown`.
- **Failure location** (the earlier the better):
  1. Before the consent card: `hyprscope control run`, `hyprscope control run --dry-run` and `hyprscope control request` reject a plan or a request that uses a missing capability (`CAPABILITY`), naming the capability id and one plain-language sentence;
  2. Recovery: a derived plan is re-checked against the same fixed baseline before the lease is renewed, so a restore step the machine cannot run faults the attempt as `recovery.capability` instead of silently renewing control;
  3. Execution time: only "the baseline says supported but the running system changed" remains, which goes through the existing fault and interference paths.
- **The baseline is absent or `incomplete`**: control is unavailable, read-only is available (`state`, `screenshot`, `events` are unaffected). The default should be off.

### 5.1 Drift and staleness

The baseline records what was measured; `src/compat/staleness.ts` asks whether the running instance still matches it. The check fails toward fewer capabilities: a value the baseline does not record is `unverified`, and a value the live compositor cannot report is `stale`.

| source | what it answers | when it runs |
|---|---|---|
| version table | schema, protocol globals, JSON field names, whether `hl.dsp.*` exists | once per Hyprland version |
| runtime queries | effective config: `configProvider`, `input:follow_mouse`, `hyprctl binds` (with modmask), `configerrors` | on probe, and before every `run`/`request` |
| thin probe | the round trips no query can replace: dispatch accepted, pointer landing, key delivery, scratch window rules, event stream | on install, and again after any invalidation |

The comparison follows four rules:

1. **Exact fields, no threshold.** Version, provider, `input:follow_mouse`, bind count, whether a plain F12 is bound, and configuration errors as a set are compared exactly; any difference is `stale`.
2. **`configHash` only when recorded.** A baseline with a generated configuration records `configHash`; a null recorded hash means no generated configuration, so there is nothing to compare. Editing a snippet changes the hash.
3. **Missing recorded value → `unverified`.** A baseline written before drift tracking has no `effective` block; it cannot attest anything, and control refuses it until it is re-probed.
4. **Unobservable live value → `stale`; `stale` outranks `unverified`.** Both verdicts fail closed: `run` (including `--dry-run`) and `request` refuse with `CAPABILITY` before any consent card.

- The configuration file is not an inference source. Under the Lua provider it is a program; under `hyprlang` it still includes other files and variables. `hyprctl getoption`, `binds` and `configerrors` report what is actually in force; a hash of the files is only a cheap staleness trigger.
- Window rules have no query API: whether a wildcard rule makes the scratch window tiled, resizes it, or refuses focus is observable only by opening that window. That observation is cheap (one window, a few reads) and stays in the thin probe.
- `doctor` reports the target, the verdict, the reasons and the field differences, and stays read-only; a stale or unverified baseline does not affect read-only observation.
- Re-probing a stale baseline is the normal probe/accept flow. For a generated desktop, stop and start the desktop first: a probe while the running compositor still uses the old configuration is refused with `DESKTOP_FAILED` (`stop and start the desktop before probing it`), and the restart creates a new signature and a new baseline entry. Narrowing still applies automatically; widening still needs a human accept.

## 6. Anti-whitewashing

This is the same trap as "consent is not certification": if the agent is both the authority on capabilities and their consumer, it can turn a failure into a pass by editing the baseline.

- The probe writes **facts**, not verdicts: the mapping from evidence to verdict is a rule table in code, not the agent's wording;
- The agent may start a probe, read evidence, explain differences, and draft explanations for humans; it may not edit the baseline, may not rewrite failed into `unknown`, and may not skip `required`;
- Run failures never write the baseline: one plan fault does not change the machine capability verdict, otherwise "cannot recover" would become a shield for "capability unsupported";
- Narrowing takes effect automatically (the safe direction); widening (`unknown` → `supported`, `advertised` → `measured`, adding a `required` item) requires a fresh human acceptance;
- Every write records the hash of the evidence file, and what the human approves is that hash.

## 7. Open questions

- **The invalidation threshold is decided**: §5.1 compares the recorded fields exactly and the generated config hash when one is recorded; there is no edit count or option whitelist.
- An `--accept-advertised` escape hatch (operate with unverified semantics when no scratch client can run): **not provided**, by decision.
- `dispatch.lua` is measured by the workspace round trip in the measure plan (re-activating the workspace the probe read first). That is accepted: it runs under the acceptance lease, it is an idempotent no-op on that workspace, and it is the only way to prove the Lua provider evaluates expressions.
- The scratch client exists (`probe/wl-scratch.c`, built by `pnpm run build:scratch`). Without it, or with `--read-only`, `dispatch.lua`, `inject.pointer`, `inject.keyboard` and `events.socket` stay `unknown` and control stays off.
- Multiple monitors, multiple seats, and fractional scaling are recorded only in the fingerprint and do not change the recovery model; multiple seats still assume a shared seat, and whether the baseline should degrade separately is undecided.
- Baseline granularity: the user's desktop keeps one machine-wide file; an `agent` or `external` desktop gets its own file keyed by its instance signature (`$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`), so a probe of one desktop never gates another. A monitor-layout change is recorded in the fingerprint but is not a compared field, so it does not invalidate a baseline today.
- Whether to support "probe only on a certain workspace" to avoid interrupting the current work: undecided.

## 8. Where it lands in code

| Location | What it does |
|---|---|
| `src/compat/catalog.ts` | Capability ids, levels, detection and consequence text, requirement maps, parameter-aware narrowing |
| `src/compat/baseline.ts` | Reader, write rules, effective set, recomputed state, atomic `0600` writes |
| `src/compat/gate.ts` | Plan-level gate, freshness gate, `CAPABILITY` failures, missing-required list |
| `src/compat/probe.ts` | Probe orchestration: lease, read-only phase, scratch client lifecycle, measure plan execution through the executor, fingerprint, evidence, draft |
| `src/compat/probeplan.ts` | Builds the measure plan from read-only facts; its steps target only the scratch window through the symbolic selector |
| `src/lease/baseline.ts` | `--probe` / `--show` / `--accept`, narrowing, pending drafts |
| `probe/wl-scratch.c`, `tools/scratch/build.sh` | The scratch window, artifact `bin/wl-scratch` |
| `src/plan/model.ts` | `requires: CapabilityId[]` on every predicate and op (still code constants) |
| `src/plan/run.ts` | Gate before the consent card, baseline receipt in the run report, derived-plan re-check |
| `src/plan/recover.ts`, `src/plan/executor.ts` | `restorability()` consults the effective set; `executePlan` also serves the probe's internal measure mode |
| `src/lease/cli.ts` | Command surface; `request` and `run --dry-run` gating; `--desktop` selection |
| `src/cli.ts`, `src/types.ts` | `doctor` baseline summary, read-only |
| `test/compat.test.ts`, `test/compat-gate.test.ts` | Catalog, reader and gate tests that need no compositor |
| `src/compat/staleness.ts` | Measures effective configuration and compares it with the fingerprint: `fresh`, `stale` or `unverified` |

The measure plan uses only ordinary catalog ops (`workspace`, `focusWindow`, `movePointer`, `assert`, `chord`, `floatWindow`, `fullscreenWindow`, `moveWindow`, `resizeWindow`), adding no expressions; a real addition must go through the same allowlist templates and the same code catalog. `hyprscope` stays read-only, and `action` stays empty.

## 9. A full installation walkthrough

```sh
pnpm run build:probe && pnpm run build:inject   # compile the probe and the injection helper
pnpm run build:scratch                          # compile the scratch client the probe measures against
node bin/hyprscope.ts control install-bind              # failsafe shortcut (optional)
node bin/hyprscope.ts control baseline --probe          # shows the lease card (allows the probe to measure the desktop temporarily); writes a draft when done
node bin/hyprscope.ts control baseline --show --diff    # human review: what is supported, what is missing, where the evidence is
node bin/hyprscope.ts control baseline --accept         # host confirms on a card; writes baseline.json
node bin/hyprscope.ts control run plan.json             # normal use afterwards
```

`--probe` only ever writes a draft; `--accept` is the human act, asked through a confirmation card on the desktop rather than a terminal command. A later probe that merely narrows the effective set applies itself and appends a revision; anything wider — including an effective capability whose evidence improved from `advertised` to `measured` — comes back as a draft that needs a fresh acceptance. After acceptance, `doctor` and every run receipt carry the baseline state (state, approval time, compositor version, missing degraded items), so changing machines does not silently continue with an old set of premises.
