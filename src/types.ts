/** Shared records for the observation contract and raw `hyprctl` output. */

/** Coded failures reported to callers. */
export type ErrorCodeValue =
  | 'USAGE'
  | 'NO_SESSION'
  | 'SESSION_GONE'
  | 'READ_ONLY'
  | 'COMMAND_FAILED'
  | 'BAD_OUTPUT'
  | 'LOCKED'
  | 'SCREENSHOT_FAILED'
  | 'TIMEOUT'
  | 'LEASE_ACTIVE'
  | 'NO_LEASE'
  | 'DENIED'
  | 'OVERLAY_FAILED'
  | 'BIND_FAILED'
  | 'PLAN_INVALID'
  | 'LEASE_MISMATCH'
  | 'FAULTED'
  | 'INJECTOR_FAILED'
  | 'CAPABILITY'
  | 'DESKTOP_FAILED'
  | 'TARGET_UNAVAILABLE'

/** A discovered Hyprland instance plus the Wayland display that belongs to it. */
export interface Session {
  runtimeDir: string
  signature: string
  instanceDir: string
  pid: number | null
  waylandDisplay: string | null
  waylandSocket: string | null
  controlSocket: string
  eventSocket: string
  source: 'explicit' | 'scan'
  instanceCount: number
  inherited: { waylandDisplay: boolean; signature: boolean }
  waylandDisplaySource: 'override' | 'lock' | 'environment' | 'socket-scan' | 'none'
}

/** Which fields of a discovered instance a caller may override. */
export interface DiscoverSessionOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  signature?: string
  waylandDisplay?: string
  /** Instance to skip during a scan, such as a managed agent desktop. */
  excludeSignature?: string
}

/** One compositor instance directory found under `$XDG_RUNTIME_DIR/hypr`. */
export interface InstanceDirectory {
  signature: string
  dir: string
  hasControl: boolean
  hasEvents: boolean
  logMtimeMs: number
  lockMtimeMs: number
}

/** Workspace identity as referenced by monitors, clients, and focus state. */
export interface WorkspaceRef {
  id: number | null
  name: string | null
}

/** Workspace record in the observation contract. */
export interface Workspace {
  id: number
  name: string
  monitor: string | null
  monitorId: number | null
  windows: number
  hasFullscreen: boolean
  lastWindow: string | null
  lastWindowTitle: string | null
  persistent: boolean | null
  layout: string | null
}

/** Monitor record in the observation contract. */
export interface Monitor {
  id: number
  name: string
  description: string | undefined
  position: { x: number; y: number }
  size: { width: number; height: number }
  scale: number
  transform: number
  refreshRate: number
  focused: boolean
  dpmsOn: boolean
  activeWorkspace: WorkspaceRef | null
  specialWorkspace: WorkspaceRef | null
  reserved: number[] | undefined
}

/** Client (toplevel) record in the observation contract. */
export interface Client {
  windowId: string
  app: string
  initialApp: string
  title: string
  pid: number | null
  monitor: number | null
  workspace: WorkspaceRef | null
  position: { x: number; y: number }
  size: { width: number; height: number }
  floating: boolean
  /** Internal fullscreen mode: 0 none, 1 fullscreen, 2 maximized. */
  fullscreen: number
  /** Client-side fullscreen mode, same encoding. */
  fullscreenClient: number
  pinned: boolean
  grouped: number
  mapped: boolean
  hidden: boolean
  acceptsInput: boolean
  xwayland: boolean
  focusHistoryId: number | null
  stableId: string | null
}

/** One layer-shell surface in the observation contract. */
export interface LayerSurface {
  monitor: string
  level: number
  namespace: string
  pid: number | null
  position: { x: number; y: number }
  size: { width: number; height: number }
  alpha: number | undefined
}

/** Lock state read from logind; `locked: null` means "no evidence". */
export interface LockState {
  locked: boolean | null
  source: 'loginctl' | 'unavailable'
  sessionId: string | null
  seat: string | null
  type: string | null
  reason?: string
}

/** Active focus summary. */
export interface ActiveState {
  readOnly: true
  observedAt: string
  window: Client | null
  workspace: Workspace | null
  monitor: string | null
}

/** Session facts repeated in reports. */
export interface SessionSummary {
  instanceSignature: string
  waylandDisplay: string | null
  pid: number | null
  runtimeDir: string
  instanceCount: number
  discovery: Session['source']
  waylandDisplaySource: Session['waylandDisplaySource']
  inheritedEnvironment: Session['inherited']
}

/** Isolation facts that callers must not assume away. */
export interface Isolation {
  mode: 'shared-seat'
  seatCount: number | null
  note: string
}

/** Full read-only desktop snapshot. */
export interface DesktopState {
  readOnly: true
  observedAt: string
  session: SessionSummary
  compositor: {
    name: 'hyprland'
    version: string | null
    branch: string | null
    configProvider: string | null
    backend: string | null
  }
  isolation: Isolation
  active: { window: Client | null; workspace: Workspace | null; monitor: string | null }
  monitors: Monitor[]
  workspaces: Workspace[]
  clients: Client[]
  layers: LayerSurface[]
  cursor: RawCursor | null
  lock: LockState
}

/** Cursor position in global layout coordinates. */
export interface RawCursor {
  x: number
  y: number
}

/** Raw `hyprctl -j clients` record; fields stay optional across Hyprland versions. */
export interface RawClient {
  address: string
  at?: [number, number]
  size?: [number, number]
  workspace?: RawWorkspace
  monitor?: number
  class?: string
  initialClass?: string
  title?: string
  pid?: number
  floating?: boolean
  /** Internal fullscreen mode: 0 none, 1 fullscreen, 2 maximized. */
  fullscreen?: number
  /** Client-side fullscreen mode, same encoding. */
  fullscreenClient?: number
  pinned?: boolean
  grouped?: unknown[]
  mapped?: boolean
  hidden?: boolean
  acceptsInput?: boolean
  xwayland?: boolean
  focusHistoryID?: number
  stableId?: string
}

/** Raw `hyprctl -j workspaces` and `-j activeworkspace` record. */
export interface RawWorkspace {
  id?: number
  name?: string
  address?: string
  type?: string
  monitor?: string
  monitorID?: number
  windows?: number
  hasfullscreen?: boolean
  lastwindow?: string | null
  lastwindowtitle?: string | null
  ispersistent?: boolean
  tiledLayout?: string
}

/** Raw `hyprctl -j monitors` record. */
export interface RawMonitor {
  id: number
  name: string
  description?: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  transform: number
  refreshRate: number
  focused: boolean
  dpmsStatus: boolean
  activeWorkspace?: RawWorkspace
  specialWorkspace?: RawWorkspace
  reserved?: number[]
}

/** Raw `hyprctl -j layers` surface record. */
export interface RawLayerSurface {
  address?: string
  x: number
  y: number
  w: number
  h: number
  alpha?: number
  namespace?: string
  pid?: number
}

/** Raw `hyprctl -j layers` map from monitor name to per-level surfaces. */
export type RawLayers = Record<string, { levels?: Record<string, RawLayerSurface[]> }>

/** Raw `hyprctl -j version` record. */
export interface RawVersion {
  version?: string
  branch?: string
  commit?: string
}

/** Raw `hyprctl -j status` record. */
export interface RawStatus {
  configProvider?: string
  backend?: string
}

/** Injectable clock and environment for deterministic tests. */
export interface Clock {
  now?: Date
  env?: NodeJS.ProcessEnv
}

/** One Wayland registry global. */
export interface WaylandGlobal {
  interface: string
  version: number
}

/** Capabilities reported from the registry probe. */
export interface WaylandProbe {
  seatCount: number | null
  globals: WaylandGlobal[]
  capabilities: {
    virtualKeyboard: boolean | null
    virtualPointer: boolean | null
    screencopy: boolean | null
    imageCopyCapture: boolean | null
    foreignToplevel: boolean | null
    workspaceManager: boolean | null
    idleNotifier: boolean | null
    sessionLock: boolean | null
    pointerWarp: boolean | null
  }
}

/** Capability baseline summary; doctor reads the file and never writes or probes it. */
export interface DoctorBaseline {
  present: boolean
  state: 'usable' | 'degraded' | 'incomplete' | null
  path: string
  approvedAt: string | null
  compositorVersion: string | null
  /** Desktop this baseline belongs to. */
  target: 'user' | 'agent' | 'external'
  /** Comparison with the running instance; null when no baseline was read. */
  staleness: {
    verdict: 'fresh' | 'stale' | 'unverified'
    reasons: string[]
    measuredAt: string
    differences: { field: string; recorded: string | null; observed: string | null }[]
  } | null
  /** Code-degraded capabilities the effective set does not grant. */
  degraded: string[]
  /** Required capabilities the effective set does not grant. */
  missingRequired: string[]
  /** Reader warnings, including why no baseline is present. */
  warnings: string[]
}

/** Quickshell runtime the consent overlay starts; doctor looks it up and never runs it. */
export interface DoctorOverlayRuntime {
  /** Configured binary name or path: `HYPRSCOPE_QUICKSHELL` when set, else `quickshell`. */
  binary: string
  /** Resolved executable path, or null when it is not on PATH. */
  path: string | null
  available: boolean
  /** Where the configured name came from. */
  source: 'default' | 'environment'
  /** Actionable note when the binary is missing; null when it was found. */
  hint: string | null
}

/** State directory doctor inspects without creating or writing anything. */
export interface DoctorStateDirectory {
  /** `$XDG_STATE_HOME/hyprscope` (or `~/.local/state/hyprscope`). */
  path: string
  /** Whether the directory itself exists. */
  exists: boolean
  /** Whether a file could be created there; null when it cannot be determined. */
  writable: boolean | null
  /** Path probed for writability: the directory itself or its nearest existing ancestor. */
  probe: string
  /** Why writability is false or unknown; null when the directory is writable. */
  reason: string | null
}

/** Environment facts doctor reports without touching the desktop. */
export interface DoctorEnvironment {
  overlay: DoctorOverlayRuntime
  state: DoctorStateDirectory
  /** How window capture sees the desktop. */
  capture: { window: string }
}

/** Report printed by `hyprscope doctor`. */
export interface DoctorReport {
  readOnly: true
  observedAt: string
  tool: { name: string; version: string; stage: number }
  discovery: SessionSummary & { runtimeDir: string; candidates: string[] }
  compositor: {
    name: 'hyprland'
    version: string | null
    branch: string | null
    commit: string | null
    configProvider: string | null
    backend: string | null
  }
  inventory: { monitors: number; workspaces: number; clients: number; layers: number }
  target: { kind: 'user' | 'agent' | 'external'; signature: string; managed: boolean }
  capabilities: { observation: string[]; action: string[]; wayland: WaylandProbe | null }
  environment: DoctorEnvironment
  baseline: DoctorBaseline
  isolation: Isolation
  limitations: string[]
}
