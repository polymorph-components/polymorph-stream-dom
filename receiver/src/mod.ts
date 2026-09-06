// Re-exports for `@polymorph/stream-dom-receiver`.

export { Reader, WireType, Writer } from "./proto.ts";
export { FrameDecoder } from "./frames.ts";
export type {
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
export {
  ALL_EVENT_FIELDS,
  ALL_QUERIES,
  ALL_STREAM_FIELDS,
  compilePolicy,
  PolicyError,
  queryAllowed,
  SURFACE_V1,
} from "./policy.ts";
export type {
  AcceptSet,
  CompiledPolicy,
  EventField,
  EventFieldSet,
  EventMessage,
  MessageAccept,
  Policy,
  Query,
  StreamField,
  StreamMessage,
} from "./policy.ts";
export { DispatchGate } from "./dispatch.ts";
export { mount } from "./mount.ts";
export type { Mounted, MountOptions } from "./mount.ts";
