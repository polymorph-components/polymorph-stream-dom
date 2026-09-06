// Re-exports for `@polymorph/stream-dom-receiver`.

export { Reader, WireType, Writer } from "./proto.ts";
export { FrameDecoder } from "./frames.ts";
export type {
  FrameSink,
  Listener,
  PropertyValue,
  TemplateAttr,
  TemplateElement,
  TemplateNode,
} from "./frames.ts";
export { RemoteDomTranscoder } from "./remote.ts";
export { encodePayload } from "./events.ts";
export { DispatchGate } from "./dispatch.ts";
export { mount } from "./mount.ts";
export type { Mounted, MountOptions } from "./mount.ts";
