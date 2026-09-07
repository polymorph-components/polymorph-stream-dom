// Re-exports for `@polymorph/stream-dom-receiver`.

export { FrameDecoder, PROTOCOL_VERSION } from "./frames.ts";
export type {
  AttrValue,
  FrameSink,
  Listener,
  ListenerTarget,
  PropertyValue,
  TemplateAttr,
  TemplateElement,
  TemplateNode,
} from "./frames.ts";
export { ListenerRegistry } from "./receiver.ts";
export type { Receiver } from "./receiver.ts";
export { validateTemplateArena } from "./templates.ts";
export { createRemoteReceiver, RemoteDomTranscoder } from "./remote.ts";
export { NativeDomReceiver } from "./native.ts";
export { encodePayload } from "./events.ts";
export { assertPolicyVersion, PolicyError, PolicySink } from "./policy.ts";
export type { Policy, PolicyOp } from "./policy.ts";
export { desktopPolicy } from "./policy-desktop.ts";
export type { DesktopPolicyOptions } from "./policy-desktop.ts";
export { DispatchGate } from "./dispatch.ts";
export { mount } from "./mount.ts";
export type { Mounted, MountOptions } from "./mount.ts";
export { createDriver } from "./driver.ts";
export type { Driver, DriverOptions, ProducerEventTarget } from "./driver.ts";
