# The capability baseline file `baseline.json`

English | [中文](/docs/BASELINE.zh.md)

> Status: **implemented**. `src/compat/baseline.ts` reads, validates and computes this file, `src/compat/probe.ts` writes drafts, and `hyprscope control baseline --accept` is the only path that records a human approval — it asks the overlay for a confirmation card and writes the file only after the host clicks it. For the design background and the probe flow, see [COMPATIBILITY.md](/docs/COMPATIBILITY.md).

`baseline.json` is **the capability verdict for one desktop**: the user's own machine, or one managed instance. It records what the probe measured, where the evidence is, and who approved it and when. It records only the first layer (machine capability); it records neither runtime state nor application behavior.

## 1. Location and ownership

| Item | Value |
|---|---|
| Approved baseline | `$XDG_STATE_HOME/hyprscope/baseline.json` for the user's desktop; `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json` for an `agent` or `external` desktop (`XDG_STATE_HOME` defaults to `~/.local/state`) |
| Draft pending approval | `baseline.pending.json` in the same directory for the user's desktop, `<signature>.pending.json` for a managed desktop, written by `baseline --probe` |
| Selector | `--desktop user|agent|external`; omitted means `user` |
| Raw evidence | `out/baseline/<probeId>/` (`probe.jsonl`: the read-only facts, the measure plan, every step's outcome and the scratch client's output; `summary.json`; `capture.png`; the measure run's plan snapshot and timeline); `out/` is already in `.gitignore`, and `HYPRSCOPE_BASELINE_EVIDENCE_DIR` moves the root for tests |
| Writer | Only `hyprscope control baseline` (a subcommand of `hyprscope control`; `--desktop` selects the file); the engine and plans read only |
| Permissions | `0600`, the same as the lease state file |
| Write method | Write a temporary file first, then rename, to avoid reading a half-written file |

The baseline is not a security boundary: it runs under the same uid as the executor, and, like the lease state, relies on "nobody edits it" rather than on permissions. What it must stop is **continuing to run with old assumptions after changing machines**, not a malicious process.

## 2. Top-level structure

| Field | Type | Meaning |
|---|---|---|
| `schema` | `1` | Format version; a reader encountering a higher version must reject it, not guess |
| `state` | `usable` \| `degraded` \| `incomplete` | See §5; computed by the writer, recomputed by the reader |
| `tool` | `{ name, version }` | The version of the tool that wrote this baseline |
| `probe` | `{ id, mode, script, startedAt, finishedAt, durationMs }` | `mode` is `full` (including the measure plan) or `read-only`; `script` is the probe script version identifier, currently `hyprscope-probe/2`, used to interpret the evidence |
| `fingerprint` | object | See §3, environment fingerprint |
| `capabilities` | `{ [id]: entry }` | See §4, capability verdicts |
| `evidence` | `{ file, sha256 }` \| `null` | The raw evidence file and its hash; losing the evidence file does not invalidate the baseline, but widening capabilities requires re-measuring |
| `approval` | `{ approvedAt, approvedBy, source, evidenceSha256 }` \| `null` | `approvedBy` may only be `human`; `source` records how it was confirmed: `overlay` (the confirmation card), `desktop` (a managed desktop's programmatic consent) or `cli` (a direct call, used by tests) |
| `revisions` | array (optional) | Audit: `{ kind: "accept" \| "narrow", at, evidenceSha256 }`; narrowing appends automatically |
| `notes` | `string[]` (optional) | Human-facing supplements such as degradation reasons; they take no part in the verdict |

A file whose `approval` is `null` is only a draft: the engine must treat it as "no baseline".

## 3. Environment fingerprint

The fingerprint describes "which environment was measured". The `effective` block and `configHash` are the values the drift check compares; the other fields are descriptive. The comparison rules are in [COMPATIBILITY.md](/docs/COMPATIBILITY.md) §5.1.

```json
{
  "compositor": {
    "name": "hyprland", "version": "0.57.2", "branch": null, "commit": "…",
    "configProvider": "lua", "backend": "drm"
  },
  "monitors": [
    { "name": "HDMI-A-1", "x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1, "refreshRate": 143.99, "transform": 0, "dpmsStatus": true }
  ],
  "seats": { "count": 1, "name": 1 },
  "waylandGlobals": [
    { "interface": "zwlr_virtual_pointer_manager_v1", "version": 2 },
    { "interface": "zwp_virtual_keyboard_manager_v1", "version": 1 }
  ],
  "config": {
    "dir": "/home/user/.config/hypr",
    "luaFile": "/home/user/.config/hypr/hyprland.lua",
    "failsafeKey": "SUPER + ALT + ESC",
    "failsafeBound": true
  },
  "helpers": { "inject": true, "scratch": true },
  "effective": {
    "configProvider": "lua",
    "followMouse": 1,
    "binds": { "count": 163, "plainF12": false },
    "configErrors": []
  },
  "configHash": "…"
}
```

`effective` and `configHash` are written by the probe and read by the staleness comparison. A baseline written by an older version has no `effective` block and is `unverified` until it is re-probed.

- `monitors` is sorted by `name`, and `waylandGlobals` by `interface`, for easy comparison;
- Field names follow the raw `hyprctl -j` output (`at`, `size`, `dpmsStatus`), not the normalized contract names of `docs/PROTOCOL.md` (`position`, `size`, `dpmsOn`). The fingerprint describes the environment, not the observation contract for callers;
- `waylandGlobals` stores the full list (not just the few we care about), so a difference is obvious at a glance when changing compositor or adding plugins;
- `helpers` records whether the two C programs are available this time: `inject` (`bin/wl-inject`) and `scratch` (`bin/wl-scratch`, built by `pnpm run build:scratch`).
- `effective` is the runtime state that can change without a version change: the config provider, `input:follow_mouse`, a bind summary, and `hyprctl configerrors`. The probe reads it with `hyprctl status`, `getoption`, `binds` and `configerrors`, never by parsing the configuration file; the compositor's `[""]` "no errors" shape is normalized to `[]`.
- `configHash` hashes the generated `hyprland.lua` and every `agent/*.lua` snippet for an `agent` desktop; it is null for the user's desktop and an `external` instance, which have no generated configuration. It is only a cheap staleness trigger, because a Lua configuration is a program and a file hash says nothing about what it did.

## 4. Capability entries

```json
{
  "dispatch.window.fullscreen-state": {
    "level": "optional",
    "status": "supported",
    "evidence": "measured",
    "checks": [
      {
        "name": "set-fullscreen",
        "at": "2026-11-17T21:40:12.345Z",
        "expected": { "internal": 1, "client": 0 },
        "observed": { "internal": 1, "client": 0 },
        "ok": true
      }
    ],
    "detail": null
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `level` | `required` \| `degraded` \| `optional` | The level at write time, **for reference only**; readers always take the code catalog as authoritative (see §6) |
| `status` | `supported` \| `unsupported` \| `unknown` | The verdict |
| `evidence` | `measured` \| `advertised` \| `unknown` | The strength of the basis for the verdict |
| `checks` | array | The round-trip record of each small step; `measured` requires at least one `ok: true` |
| `detail` | `string` \| `null` | The reason when unsupported or unknown, one sentence |

Write rules:

- `status: "supported"` with `evidence: "measured"`: at least one successful round-trip record;
- `status: "supported"` with `evidence: "advertised"`: allowed only on `optional` or `degraded` capabilities, and `checks` holds field/protocol existence records;
- `status: "unsupported"`: must have `detail`, and `checks` keeps the failed round-trip records;
- `status: "unknown"`: not measured or not measurable, `detail` explains why.

## 5. How `state` is computed

```
requiredOk = ∀ cap, level(cap) === 'required' ⇒
               status === 'supported' && evidence === 'measured'
degradedOk = ∀ cap, level(cap) === 'degraded' ⇒
               status === 'supported' && evidence !== 'unknown'

state = !requiredOk  ? 'incomplete'
      : !degradedOk  ? 'degraded'
      :                'usable'
```

- `incomplete`: control is unavailable, read-only is available;
- `degraded`: control is available, but one safety path is missing (for example the failsafe shortcut); the receipt and `doctor` must state it;
- `usable`: everything meets the bar.

The file is selected by `--desktop`: `hyprscope control baseline --probe / --show / --accept --desktop user|agent|external`, omitted meaning `user`. State is computed per file, so one desktop's verdict never gates another.

## 6. Reader rules (engine side)

```
effective(cap) =
     code declares cap
  && entry.status === 'supported'
  && entry.evidence !== 'unknown'                 # supported + unknown is treated as unknown
  && (entry.evidence === 'measured' || level(cap) !== 'required')
```

The other fault-tolerance rules all lean in the direction of "fewer capabilities":

| Case | Handling |
|---|---|
| The file does not exist, `approval` is `null` | Treat as no baseline at all → control is unavailable |
| `schema` is higher than the code supports | Refuse to read, treat as no baseline |
| `capabilities` contains an id the code does not know | Ignore and warn (possibly written by a newer version) |
| Some id is missing | Treat as `unknown` |
| An entry's `level` disagrees with the code catalog | The code wins; ignore the file value and warn |
| `status: supported` but `evidence: unknown` | Treat as `unknown` |
| The `state` field disagrees with the recomputed result | The recomputed result wins; warn |
| The evidence file has been cleaned up | The baseline stays valid; but the next capability widening must re-probe |
| The running instance's effective config differs from the fingerprint, or the live compositor cannot report a value | Mark the baseline `stale`; `run`/`request` refuse with `CAPABILITY` until it is re-probed |
| The baseline has no `effective` block (written before drift tracking) | Mark it `unverified`; control refuses it with `CAPABILITY` until it is re-probed |
| The recorded `configHash` differs from the generated config on disk | Mark it `stale`; stop and start the desktop, then re-probe, because the running compositor still uses the old configuration |

These rules point at the same thing: **the file may be read badly or written badly; the worst outcome can only be fewer capabilities.** No rule may let data widen capabilities beyond what the code declares.

## 7. Approval and narrowing

1. `hyprscope control baseline --probe [--desktop user|agent|external]` builds the measure plan from facts the read-only phase already measured (the active workspace name, the layout origin, the pre-existing active window), obtains its lease (a card on the user's desktop showing that plan's preview under a probe-specific title; programmatic inside a managed desktop — see below), starts its scratch client, signals it `SIGUSR1` to lift its fixed size hints, and executes the measure plan through the executor's internal measure mode. A step that cannot be committed or verified is recorded and the run continues; only a lost lease, the plan's time budget or a foreign desktop change stops it. The probe then writes `baseline.pending.json` (`approval: null`) and the evidence directory, and prints what was measured, what is missing and where the evidence is. Nothing becomes usable here: a pending draft is treated as no baseline at all;
2. `hyprscope control baseline --accept [--desktop user|agent|external]` asks the host to confirm the draft. On the user's desktop the overlay shows a confirmation card carrying the verdict (`state`), the required/optional capability counts and the evidence hash; only the host's click promotes pending to the formal file, writing `approval` and `revisions`. A card that is denied or expires writes nothing and keeps the draft. The command re-reads the evidence file the draft names and refuses when its hash no longer matches, so the approval binds the bytes the human reviewed (a cleaned-up evidence file is a warning, not a failure). The probe's lease card and the acceptance confirmation are two different consents (one card mechanism, two separate human approvals) and cannot be merged;
3. Later re-probing **only narrows**: when the new effective set is a subset of the old one and no effective capability's evidence improved, change the formal file directly (`state` may drop to `degraded`/`incomplete`), keep the existing `approval`, and append a `revisions[kind: "narrow"]` entry; no fresh approval is needed. The old `approval.evidenceSha256` keeps naming the evidence the human actually reviewed, while `evidence` and the revision name the new measurement;
4. Any widening — `unknown` becoming `supported`, `advertised` becoming `measured` for a capability that is already effective, adding a `required` item, adding a capability id — must go through human acceptance again. The probe treats an effective capability whose evidence improved from `advertised` to `measured` as a widening, so a machine that compiled the scratch client later re-accepts rather than silently upgrading its evidence;
5. Narrowing needs no fresh approval because it only makes the tool more conservative; widening means "allow me to do what was not allowed last time" and must go through the human again.

Inside an `agent` or `external` desktop the probe uses the programmatic lease: the human consent was given once at `desktop start`/`desktop attach`, so no card is shown, and acceptance is recorded programmatically under that same consent. The user's desktop keeps the probe's lease card and asks for acceptance with a confirmation card of its own. Acceptance is always a separate human act, and `--accept` selects the same `--desktop`.

## 8. Relationship to plans and leases

- The capability set is determined when `hyprscope control run` starts: validation rejects predicates and ops that use a missing capability, and rejects **before requesting the lease**, avoiding a consent card for a plan that is doomed to fail; a stale or unverified baseline is refused the same way (`CAPABILITY`);
- The probe's measure plan is an ordinary validated plan executed by the same executor in an internal measure mode; neither `hyprscope control run` nor a plan document can request that mode, and it never runs recovery or an interference prompt;
- The run receipt records the baseline used this time: `state`, `approvedAt`, `fingerprint.compositor.version`, and the list of degraded items;
- The baseline file is per desktop: `--desktop` selects it, and a managed desktop's file is keyed by its signature, so one desktop's verdict never gates another;
- The baseline does not replace plan consent, nor the per-step lease gate: it answers only "does this machine support it", not "is the desktop allowed to be touched this time";
- If the baseline file is changed during a run, it does not affect an already-started run; this is consistent with the lease trust model — both are correctness mechanisms, not security boundaries.
