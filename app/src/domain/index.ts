// Barrel for `@/domain` — the module's public surface.
export { findCapability } from './capabilities'
export type { Capability, CapabilityKind } from './capabilities'
export type { Connector, ConnectorHealth, ConnectorStatus, DeviceCommand, DeviceUpdate, Unsubscribe } from './connector'
export { deviceCapability, mergeCapabilities } from './device'
export type { Device, DeviceBattery, DeviceCategory } from './device'
export { DigitalTwinRuntime } from './runtime'
