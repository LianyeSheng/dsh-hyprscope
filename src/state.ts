/** Normalize `hyprctl` records into the observation contract consumed by callers. */
import { hyprctlJson } from './hyprctl.ts'
import { readLockState } from './lock.ts'
import type {
  ActiveState, Client, DesktopState, Isolation, LayerSurface, Monitor, RawClient, RawCursor,
  RawLayers, RawMonitor, RawStatus, RawVersion, RawWorkspace, Session, SessionSummary, Workspace,
  WorkspaceRef,
} from './types.ts'

/** Query options shared by every read in one snapshot. */
export interface ReadOptions {
  timeoutMs?: number
}

/**
 * Reference a workspace by identity rather than by its full record.
 * @param raw Workspace record, possibly empty.
 * @returns Workspace reference, or null when the record carries no name.
 */
function workspaceRef(raw: RawWorkspace | null | undefined): WorkspaceRef | null {
  if (raw?.name === undefined || raw.name === '') return null
  return { id: raw.id ?? null, name: raw.name }
}

/**
 * Normalize one monitor record.
 * @param raw `hyprctl monitors -j` entry.
 * @returns Observation-contract monitor.
 */
export function normalizeMonitor(raw: RawMonitor): Monitor {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    position: { x: raw.x, y: raw.y },
    size: { width: raw.width, height: raw.height },
    scale: raw.scale,
    transform: raw.transform,
    refreshRate: raw.refreshRate,
    focused: raw.focused,
    dpmsOn: raw.dpmsStatus,
    activeWorkspace: workspaceRef(raw.activeWorkspace),
    specialWorkspace: workspaceRef(raw.specialWorkspace),
    reserved: raw.reserved,
  }
}

/**
 * Normalize one workspace record.
 * @param raw `hyprctl workspaces -j` entry.
 * @returns Observation-contract workspace.
 */
export function normalizeWorkspace(raw: RawWorkspace): Workspace {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    monitor: raw.monitor ?? null,
    monitorId: raw.monitorID ?? null,
    windows: raw.windows ?? 0,
    hasFullscreen: raw.hasfullscreen ?? false,
    lastWindow: raw.lastwindow ?? null,
    lastWindowTitle: raw.lastwindowtitle ?? null,
    persistent: raw.ispersistent ?? null,
    layout: raw.tiledLayout ?? null,
  }
}

/**
 * Normalize one client (toplevel) record.
 * @param raw `hyprctl clients -j` entry.
 * @returns Observation-contract client.
 */
export function normalizeClient(raw: RawClient): Client {
  const [x = 0, y = 0] = raw.at ?? []
  const [width = 0, height = 0] = raw.size ?? []
  return {
    windowId: raw.address,
    app: raw.class ?? '',
    initialApp: raw.initialClass ?? '',
    title: raw.title ?? '',
    pid: raw.pid ?? null,
    monitor: raw.monitor ?? null,
    workspace: workspaceRef(raw.workspace),
    position: { x, y },
    size: { width, height },
    floating: raw.floating ?? false,
    fullscreen: raw.fullscreen ?? 0,
    fullscreenClient: raw.fullscreenClient ?? 0,
    pinned: raw.pinned ?? false,
    grouped: Array.isArray(raw.grouped) ? raw.grouped.length : 0,
    mapped: raw.mapped ?? true,
    hidden: raw.hidden ?? false,
    acceptsInput: raw.acceptsInput ?? true,
    xwayland: raw.xwayland ?? false,
    focusHistoryId: raw.focusHistoryID ?? null,
    stableId: raw.stableId ?? null,
  }
}

/**
 * Flatten layer-shell surfaces per monitor and level.
 * @param raw `hyprctl layers -j` map.
 * @returns One entry per surface, ordered by monitor and level.
 */
export function normalizeLayers(raw: RawLayers | null): LayerSurface[] {
  const surfaces: LayerSurface[] = []
  for (const [monitor, entry] of Object.entries(raw ?? {})) {
    for (const [level, layers] of Object.entries(entry?.levels ?? {})) {
      for (const layer of layers ?? []) {
        surfaces.push({
          monitor,
          level: Number.parseInt(level, 10),
          namespace: layer.namespace ?? '',
          pid: layer.pid ?? null,
          position: { x: layer.x, y: layer.y },
          size: { width: layer.w, height: layer.h },
          alpha: layer.alpha,
        })
      }
    }
  }
  return surfaces.sort((a, b) => a.monitor.localeCompare(b.monitor) || a.level - b.level
    || a.namespace.localeCompare(b.namespace))
}

/**
 * Describe the discovered session for reports.
 * @param session Discovered session.
 * @returns Session summary.
 */
export function describeSession(session: Session): SessionSummary {
  return {
    instanceSignature: session.signature,
    waylandDisplay: session.waylandDisplay,
    pid: session.pid,
    runtimeDir: session.runtimeDir,
    instanceCount: session.instanceCount,
    discovery: session.source,
    waylandDisplaySource: session.waylandDisplaySource,
    inheritedEnvironment: session.inherited,
  }
}

/**
 * The isolation facts a caller must not assume away.
 * @returns Isolation summary for this compositor.
 */
export function describeIsolation(): Isolation {
  return {
    mode: 'shared-seat',
    seatCount: null,
    note: 'One wl_seat serves every client. Pointer motion and keystrokes reach the focused window of the session the user is using.',
  }
}

/**
 * Collect a read-only snapshot of the desktop.
 * @param session Discovered session.
 * @param options Per-query timeout.
 * @returns Observation snapshot.
 */
export async function readState(session: Session, options: ReadOptions = {}): Promise<DesktopState> {
  const query = <T>(command: string) => hyprctlJson<T>(session, command, [], options)
  const [clients, workspaces, monitors, activeWindow, activeWorkspace, layers, cursor, version, status, lock] =
    await Promise.all([
      query<RawClient[]>('clients'), query<RawWorkspace[]>('workspaces'), query<RawMonitor[]>('monitors'),
      query<RawClient>('activewindow'), query<RawWorkspace>('activeworkspace'), query<RawLayers>('layers'),
      query<RawCursor>('cursorpos'), query<RawVersion>('version'), query<RawStatus>('status'), readLockState(),
    ])
  const monitorRecords = (monitors ?? []).map(normalizeMonitor)
  const windowRecord = activeWindow !== null && Object.keys(activeWindow).length > 0 ? normalizeClient(activeWindow) : null
  const workspaceRecord = activeWorkspace !== null && Object.keys(activeWorkspace).length > 0
    ? normalizeWorkspace(activeWorkspace) : null
  const activeMonitor = monitorRecords.find(monitor => windowRecord !== null
    ? monitor.id === windowRecord.monitor
    : monitor.name === workspaceRecord?.monitor)
  return {
    readOnly: true,
    observedAt: new Date().toISOString(),
    session: describeSession(session),
    compositor: {
      name: 'hyprland',
      version: version?.version ?? null,
      branch: version?.branch ?? null,
      configProvider: status?.configProvider ?? null,
      backend: status?.backend ?? null,
    },
    isolation: describeIsolation(),
    active: {
      window: windowRecord,
      workspace: workspaceRecord,
      monitor: activeMonitor?.name ?? workspaceRecord?.monitor ?? null,
    },
    monitors: monitorRecords,
    workspaces: (workspaces ?? []).map(normalizeWorkspace),
    clients: (clients ?? []).map(normalizeClient),
    layers: normalizeLayers(layers),
    cursor,
    lock,
  }
}

/**
 * Read only the active window and workspace.
 * @param session Discovered session.
 * @param options Per-query timeout.
 * @returns Active focus summary.
 */
export async function readActive(session: Session, options: ReadOptions = {}): Promise<ActiveState> {
  const [activeWindow, activeWorkspace] = await Promise.all([
    hyprctlJson<RawClient>(session, 'activewindow', [], options),
    hyprctlJson<RawWorkspace>(session, 'activeworkspace', [], options),
  ])
  return {
    readOnly: true,
    observedAt: new Date().toISOString(),
    window: activeWindow !== null && Object.keys(activeWindow).length > 0 ? normalizeClient(activeWindow) : null,
    workspace: activeWorkspace !== null && Object.keys(activeWorkspace).length > 0
      ? normalizeWorkspace(activeWorkspace) : null,
    monitor: activeWorkspace?.monitor ?? null,
  }
}
