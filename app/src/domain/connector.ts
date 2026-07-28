/**
 * connector.ts — the Connector contract.
 *
 * The single boundary between the manufacturer-neutral core and any concrete
 * ecosystem. A connector translates one vendor world (Home Assistant, MQTT,
 * Tuya, a brand cloud …) into Devices and Capabilities, and nothing else: the
 * runtime adopts it blind to which protocol it speaks, and routes every command
 * back to the connector that owns the target device.
 *
 * Types only — there is no implementation here on purpose, so the core never
 * gains a dependency on any particular ecosystem.
 */

import type { Capability, CapabilityKind } from './capabilities'
import type { Device, DeviceBattery, DeviceHealth, DeviceTelemetry } from './device'

/** Cancels a subscription. Returned by every `subscribe`-shaped call. */
export type Unsubscribe = () => void

/** Lifecycle of a connector's link to its backend. */
export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Connector-level health — the link, not any single device. */
export interface ConnectorHealth {
  status: ConnectorStatus
  /** ISO timestamp of the last successful exchange. */
  lastSync?: string
  /** Human-readable detail, typically the last error. */
  message?: string
}

/** Identity a connector reports to the runtime. */
export interface ConnectorInfo {
  id: string
  label: string
}

/**
 * A partial, connector-reported device change. Only the fields that actually
 * changed are sent; the runtime merges them into the twin.
 */
export interface DeviceUpdate {
  deviceId: string
  capabilities?: Capability[]
  health?: Partial<DeviceHealth>
  battery?: DeviceBattery
  telemetry?: DeviceTelemetry
}

/**
 * A write request against one capability of one device. The payload is the
 * capability's own value shape (e.g. `{ on: true }`, `{ percent: 40 }`).
 */
export interface DeviceCommand {
  deviceId: string
  capability: CapabilityKind
  payload: Record<string, string | number | boolean>
}

/**
 * The contract every ecosystem integration implements. Adding an ecosystem
 * means adding a connector — never touching the core.
 */
export interface Connector {
  info: ConnectorInfo
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Full device list on first contact. */
  discover(): Promise<Device[]>
  /** Re-read the current device list (manual refresh). */
  synchronize(): Promise<Device[]>
  /** Stream incremental device changes. */
  subscribe(onUpdate: (update: DeviceUpdate) => void): Unsubscribe
  /** Execute a write against the owning backend. */
  publish(command: DeviceCommand): Promise<void>
  /** Current link health (pull). */
  health(): ConnectorHealth
  /** Optional pushed link health. Connectors without it are polled via `health()`. */
  onStatus?(listener: (health: ConnectorHealth) => void): Unsubscribe
}
