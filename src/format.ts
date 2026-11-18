/** Human-readable rendering; JSON is the machine-readable contract. */
import type { ActiveState, Client, DesktopState, DoctorReport, LayerSurface, Monitor, Workspace } from './types.ts'
import type { CaptureResult } from './screenshot.ts'

/** @param value Any scalar. @returns Display text. */
const text = (value: unknown): string => value === null || value === undefined ? '-' : String(value)
/** @param value Any scalar. @param width Minimum width. @returns Padded text. */
const pad = (value: unknown, width: number): string => text(value).padEnd(width)
/** @param value Any scalar. @param max Maximum display length. @returns Clipped text. */
const clip = (value: unknown, max: number): string => {
  const valueText = text(value)
  return valueText.length <= max ? valueText : `${valueText.slice(0, max - 1)}…`
}
/** @param value Tri-state flag. @returns yes/no/? */
const onOff = (value: boolean | null): string => value === true ? 'yes' : value === false ? 'no' : '?'
/** @param lines Lines to join. @returns One block of text. */
const block = (lines: string[]): string => lines.join('\n')

/**
 * Render a discovery and capability report.
 * @param report Doctor report.
 * @returns Human-readable report.
 */
export function renderDoctor(report: DoctorReport): string {
  const { discovery, compositor, inventory, capabilities, isolation, limitations } = report
  const lines = [
    `${report.tool.name} ${report.tool.version} — stage ${report.tool.stage} (read-only)`,
    '',
    'discovery',
    `  runtime dir   ${discovery.runtimeDir}`,
    `  instance      ${clip(discovery.instanceSignature, 24)} (${discovery.discovery}, ${discovery.instanceCount} running)`,
    `  wayland       ${text(discovery.waylandDisplay)} (from ${discovery.waylandDisplaySource})`,
    `  inherited     WAYLAND_DISPLAY=${onOff(discovery.inheritedEnvironment.waylandDisplay)}`
      + `  HYPRLAND_INSTANCE_SIGNATURE=${onOff(discovery.inheritedEnvironment.signature)}`,
    '',
    'compositor',
    `  hyprland ${text(compositor.version)} (${text(compositor.branch)})`
      + ` · ${text(compositor.configProvider)} config · ${text(compositor.backend)} backend`,
    '',
    'inventory',
    `  monitors ${inventory.monitors} · workspaces ${inventory.workspaces}`
      + ` · clients ${inventory.clients} · layer surfaces ${inventory.layers}`,
    '',
    'capabilities',
    `  observation   ${capabilities.observation.join(', ')}`,
    '  action        none — stage 0 is read-only',
  ]
  const wayland = capabilities.wayland
  if (wayland !== null) {
    const flags = Object.entries(wayland.capabilities)
      .filter(([, present]) => present === true)
      .map(([name]) => name)
    lines.push(`  wayland       ${wayland.globals.length} globals`
      + ` · seatCount ${text(wayland.seatCount)} · ${flags.join(' ') || 'no injection protocols'}`)
  } else {
    lines.push('  wayland       probe not built (run: pnpm run build:probe)')
  }
  lines.push('', 'isolation', `  ${isolation.mode}: ${isolation.note}`)
  if (limitations.length > 0) {
    lines.push('', 'limitations', ...limitations.map(limitation => `  - ${limitation}`))
  }
  return block(lines)
}

/**
 * Render a desktop snapshot.
 * @param state Observation snapshot.
 * @returns Human-readable snapshot.
 */
export function renderState(state: DesktopState): string {
  const { compositor, session, active, monitors, workspaces, clients, layers, cursor, lock } = state
  const headline = `hyprland ${text(compositor.version)} (${text(compositor.configProvider)})`
    + ` · ${text(session.waylandDisplay)} · instance ${clip(session.instanceSignature, 12)}`
  const lines = [headline, `observed ${state.observedAt}`, '', 'active']
  if (active.window === null) {
    lines.push('  window      none')
  } else {
    lines.push(`  window      ${text(active.window.app)} · ${clip(active.window.title, 64)}`)
    lines.push(`              ${text(active.window.windowId)} · workspace ${text(active.window.workspace?.name)}`
      + ` · ${active.window.size.width}×${active.window.size.height}`
      + ` at ${active.window.position.x},${active.window.position.y} · pid ${text(active.window.pid)}`)
  }
  lines.push(`  workspace   ${text(active.workspace?.name)} · monitor ${text(active.monitor)}`)
  lines.push('', `monitors (${monitors.length})`)
  for (const monitor of monitors) {
    lines.push(`  ${pad(monitor.name, 12)} ${monitor.size.width}×${monitor.size.height}`
      + ` scale ${monitor.scale} at ${monitor.position.x},${monitor.position.y}`
      + ` ws ${text(monitor.activeWorkspace?.name)}${monitor.focused ? ' focused' : ''}`)
  }
  lines.push('', `workspaces (${workspaces.length})`)
  for (const workspace of workspaces) {
    lines.push(`  ${pad(workspace.id, 4)} ${pad(workspace.name, 12)} ${pad(workspace.monitor, 12)} windows ${workspace.windows}`)
  }
  lines.push('', `clients (${clients.length})`)
  for (const client of clients) {
    lines.push(`  ${pad(client.windowId, 16)} ${pad(client.app, 16)} ws ${pad(client.workspace?.name, 4)}`
      + ` ${client.size.width}×${client.size.height} ${clip(client.title, 48)}`)
  }
  lines.push('', `layers (${layers.length})`)
  for (const layer of layers) {
    lines.push(`  ${pad(layer.monitor, 12)} level ${pad(layer.level, 2)} ${pad(layer.namespace, 28)} pid ${text(layer.pid)}`)
  }
  lines.push('', `cursor  ${cursor === null ? '?' : `${cursor.x},${cursor.y}`}`)
  lines.push(`lock    ${lock.locked === true ? 'locked' : `unknown (${text(lock.reason ?? 'not reported')})`}`)
  return block(lines)
}

/**
 * Render the active focus.
 * @param active Active summary.
 * @returns Human-readable focus.
 */
export function renderActive(active: ActiveState): string {
  const { window, workspace } = active
  const lines: string[] = []
  lines.push(window === null ? 'window      none'
    : `window      ${text(window.app)} · ${text(window.title)}`)
  if (window !== null) {
    lines.push(`            ${window.windowId} · ${window.size.width}×${window.size.height}`
      + ` at ${window.position.x},${window.position.y} · pid ${text(window.pid)}`)
  }
  lines.push(workspace === null ? 'workspace   none'
    : `workspace   ${workspace.name} · monitor ${text(workspace.monitor)} · windows ${workspace.windows}`)
  return block(lines)
}

/**
 * Render windows.
 * @param clients Normalized clients.
 * @returns Human-readable list.
 */
export function renderClients(clients: Client[]): string {
  if (clients.length === 0) return 'no clients'
  return block(clients.map(client => [
    pad(client.windowId, 16), pad(client.app, 18), `ws ${pad(client.workspace?.name, 4)}`,
    `${pad(client.size.width, 5)}×${pad(client.size.height, 5)}`, `pid ${pad(client.pid, 7)}`,
    client.floating ? 'floating' : 'tiled', clip(client.title, 56),
  ].join(' ')))
}

/**
 * Render workspaces.
 * @param workspaces Normalized workspaces.
 * @returns Human-readable list.
 */
export function renderWorkspaces(workspaces: Workspace[]): string {
  if (workspaces.length === 0) return 'no workspaces'
  return block(workspaces.map(workspace => [
    `id ${pad(workspace.id, 4)}`, pad(workspace.name, 16), pad(workspace.monitor, 14),
    `windows ${pad(workspace.windows, 3)}`, workspace.layout ?? '-',
  ].join(' ')))
}

/**
 * Render monitors.
 * @param monitors Normalized monitors.
 * @returns Human-readable list.
 */
export function renderMonitors(monitors: Monitor[]): string {
  if (monitors.length === 0) return 'no monitors'
  return block(monitors.map(monitor => [
    pad(monitor.name, 14), `${monitor.size.width}×${monitor.size.height}`,
    `scale ${pad(monitor.scale, 4)}`, `at ${monitor.position.x},${monitor.position.y}`,
    `ws ${pad(monitor.activeWorkspace?.name, 4)}`, monitor.focused ? 'focused' : '-',
    monitor.dpmsOn ? 'dpms-on' : 'dpms-off',
  ].join(' ')))
}

/**
 * Render layer-shell surfaces.
 * @param layers Normalized layers.
 * @returns Human-readable list.
 */
export function renderLayers(layers: LayerSurface[]): string {
  if (layers.length === 0) return 'no layer surfaces'
  return block(layers.map(layer => [
    pad(layer.monitor, 14), `level ${pad(layer.level, 2)}`, pad(layer.namespace, 32),
    `pid ${pad(layer.pid, 7)}`, `${layer.position.x},${layer.position.y}`, `${layer.size.width}×${layer.size.height}`,
  ].join(' ')))
}

/**
 * Render a capture result.
 * @param result Capture metadata.
 * @returns Human-readable result.
 */
export function renderScreenshot(result: CaptureResult): string {
  return block([
    result.path,
    `${result.width}×${result.height} · ${result.bytes} bytes · sha256 ${result.sha256.slice(0, 16)}…`,
    `scope ${result.source.scope}${result.source.monitor === null ? '' : ` · monitor ${result.source.monitor}`}`
      + `${result.source.region === null ? '' : ` · region ${Object.values(result.source.region).join(',')}`}`,
    `captured ${result.capturedAt}`,
  ])
}

/**
 * Render the pointer position.
 * @param cursor Cursor position.
 * @returns Human-readable position.
 */
export function renderCursor(cursor: { x: number; y: number } | null): string {
  return cursor === null ? 'cursor position unavailable' : `${cursor.x},${cursor.y}`
}
