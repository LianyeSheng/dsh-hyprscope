# Documentation index

English | [中文](/docs/INDEX.zh.md)

This index is the entry point for understanding what hyprscope does, how it is designed, and why the design is what it is. The documents are the contract and the code implements it; read the English side of a pair only, because the Chinese side carries the same content.

## 1. Read in this order

Every in-scope document appears in this list; the consistency check fails when a document under `docs/` is missing here, or when this list names a document that no longer exists.

1. [README.md](/README.md) — positioning, the feature set, the two surfaces and the quick start.
2. [PROTOCOL.md](/docs/PROTOCOL.md) — what is observed and how it is reported: snapshot, coordinates, event stream, error codes, capability report; §8–§9 declare the control surface.
3. [LEASE.md](/docs/LEASE.md) — why control is consent-gated: lifecycle, state and files, failsafe chain, boundaries ("why we do not intercept input") and limitations.
4. [PLAN.md](/docs/PLAN.md) — plan schema, preconditions and expectations, ops, interference policy, recovery, fault record, consent binding, limits and non-goals.
5. [BASELINE.md](/docs/BASELINE.md) and [COMPATIBILITY.md](/docs/COMPATIBILITY.md) — why control refuses without a measured baseline: state computation, reader rules, human approval and narrowing, drift and staleness.
6. [DESKTOP.md](/docs/DESKTOP.md) — why an agent gets its own nested compositor: addressing, lifecycle, directories, consent, failures and what it is not.
7. [DSH-PLUGIN.md](/docs/DSH-PLUGIN.md) — the agent-facing wrapper and why it stays thin: the six tools, the desktop-message hint and shortcut, and how the safety boundary holds.
8. [VERIFICATION.md](/docs/VERIFICATION.md) — one recorded real-machine verification; evidence for that machine, not an ongoing guarantee.

## 2. Where the motivation lives

Design intent is written down, not left implicit in the code. Look for the sections that name it: Positioning, Boundaries, Limits and non-goals, and What it is not. Do not infer intent from the code alone. When a document and the code disagree, the tests establish behavior and the document records intent, so fix both in the same commit.

## 3. Contract to code map

| Area | Contract | Code |
|---|---|---|
| read-only commands | `docs/PROTOCOL.md` | `src/cli.ts` |
| control lease | `docs/LEASE.md` | `src/lease/` |
| plan language | `docs/PLAN.md` | `src/plan/` |
| capability baseline | `docs/BASELINE.md`, `docs/COMPATIBILITY.md` | `src/compat/` |
| agent desktop | `docs/DESKTOP.md` | `src/desktop/` |
| DSH plugin and desktop messages | `docs/DSH-PLUGIN.md` | `plugins/dsh-hyprscope/`, `src/message/`, `overlay/message/` |
