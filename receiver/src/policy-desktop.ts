// The first concrete embedder policy (docs/design.md "Policy": "This
// protocol ships no allowlist ... What it ships is the seam"): a
// fail-closed vocabulary for an UNTRUSTED producer — a third-party plugin
// in a wasmtime sandbox — rendered into a privileged host webview. Any
// DOM-level escape (`<script>`, `on*`, `javascript:` URLs, `srcdoc`,
// navigation-forcing attributes) here is a sandbox escape into the app,
// so every rule below is deny-by-default: an element, attribute, property
// or event name this file has not named on an explicit allowlist is
// rejected, not merely the ones enumerated as obviously dangerous.
//
// What this policy cannot see: `id`/`class` values a producer sets are
// ordinary strings, and can collide with names the host page's own script
// uses (`document.getElementById`, `document.forms.foo`, a CSS rule
// keyed on a class) — the embedder's discipline is to give the mount
// its own subtree and never rely on global/unprefixed lookups reaching
// into it. Nodes materialized by `cloneTemplate` are not counted toward
// `maxNodes` (see that option's doc). Text content (`setText`/
// `createText`) has no length rule here at all; the only ceiling on it
// is `MAX_FRAME_BYTES` (frames.ts), which bounds a whole frame rather
// than one string.

import { PROTOCOL_VERSION } from "./frames.ts";
import type { Policy, PolicyOp } from "./policy.ts";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

// Hoisted rather than allocated per `check()` call (review finding 9).
const ELEMENT_NS = new Set([XHTML_NS, SVG_NS]);
const ATTR_NS = new Set([XLINK_NS, XML_NS]);

const ELEMENT_TAGS = new Set([
  // structural
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "footer",
  "main",
  "section",
  "article",
  "nav",
  "aside",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "pre",
  "code",
  "blockquote",
  "br",
  "hr",
  "small",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "mark",
  "time",
  "abbr",
  "figure",
  "figcaption",
  "details",
  "summary",
  // forms
  "form",
  "label",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "button",
  "fieldset",
  "legend",
  "progress",
  "meter",
  "output",
  "datalist",
  // media
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "canvas",
  // links
  "a",
  // SVG
  "svg",
  "path",
  "g",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "text",
  "tspan",
  "defs",
  "use",
  "symbol",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
]);

// Named explicitly (rather than left to fall out of ELEMENT_TAGS not
// listing them) so a future addition to ELEMENT_TAGS cannot silently
// re-admit one of these by omission going unnoticed in review.
const DENIED_TAGS = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "style",
  "template",
  "slot",
  "portal",
  "html",
  "head",
  "body",
  "title",
  "math",
]);

// URL-kind attributes (proto `AttrValue`'s `asset` arm, docs/design.md
// "Assets are handles, not bytes and not URLs"): a text value is judged
// below (asset-only by default; `href` on `<a>` gets the `relativeHref`/
// `externalLinks` exceptions). `formaction`/`action` are deliberately
// NOT here even though they carry URLs: a `<form>`'s submission target
// is exactly the navigation surface this policy exists to deny, so they
// are absent from every allowlist here and fall through to the
// catch-all rejection regardless of value kind.
const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "poster",
  "data",
  "cite",
  "background",
  "manifest",
  "srcset",
]);

const ALLOWED_NS_ATTRS = new Set(["xlink:href", "xml:lang", "xml:space"]);

// `name` is not in here: it is checked separately, per-tag (below) —
// `<form name>`/`<img name>` clobber `document.*` via named-property
// access ([HTMLDocument] "supported property names" / `[LegacyOverride
// BuiltIns]`), so it is admitted only on tags that cannot make that
// happen.
const NAME_ALLOWED_TAGS = new Set([
  "input",
  "select",
  "textarea",
  "button",
  "output",
  "fieldset",
  "meter",
  "progress",
]);

// Attribute allowlist (review finding 6/2/3: the header comment promises
// deny-by-default, so an omission here — not membership on a denylist —
// is what rejects an attribute). `aria-*`/`data-*` are prefix-matched,
// not listed. `style`, the URL-kind attributes and `name` are handled by
// their own branches in `check()`, not by this set.
const ALLOWED_ATTRS = new Set([
  // global
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "hidden",
  "tabindex",
  "role",
  "translate",
  "spellcheck",
  "autocapitalize",
  "inputmode",
  "enterkeyhint",
  // form controls (excl. `name`, handled separately)
  "type",
  "value",
  "placeholder",
  "disabled",
  "checked",
  "readonly",
  "required",
  "min",
  "max",
  "step",
  "pattern",
  "autocomplete",
  "autofocus",
  "for",
  "maxlength",
  "minlength",
  "multiple",
  "size",
  "rows",
  "cols",
  "wrap",
  "selected",
  "label",
  "list",
  // media (excl. `src`/`srcset`, URL-kind)
  "alt",
  "width",
  "height",
  "loading",
  "decoding",
  "controls",
  "autoplay",
  "loop",
  "muted",
  "preload",
  "playsinline",
  // <a> (excl. `href`, URL-kind; NOT `download`, NOT `target`)
  "rel",
  "hreflang",
  // table
  "colspan",
  "rowspan",
  "scope",
  "headers",
  "span",
  "abbr",
  // <time>
  "datetime",
  // <progress>/<meter>
  "low",
  "high",
  "optimum",
  // <details>
  "open",
  // <ol>
  "start",
  "reversed",
  // <track>
  "kind",
  "srclang",
  "default",
  // SVG presentation/geometry
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "opacity",
  "viewbox",
  "preserveaspectratio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "transform",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "clip-path",
  "mask",
  "pathlength",
  "vector-effect",
]);

const PROPERTY_ALLOWLIST = new Set([
  "value",
  "checked",
  "selected",
  "disabled",
  "readOnly",
  "required",
  "multiple",
  "hidden",
  "open",
  "indeterminate",
  "className",
  "id",
  "title",
  "placeholder",
  "textContent",
  "innerText",
  "scrollTop",
  "scrollLeft",
  "currentTime",
  "volume",
  "muted",
  "playbackRate",
]);

const WINDOW_EVENTS = new Set(["hashchange", "popstate", "resize"]);
// `keydown`/`keyup` are deliberately absent: a `document`-level listener
// for either sees every keystroke typed anywhere in the privileged page,
// not just inside the producer's mount (review: document keylogging).
const DOCUMENT_EVENTS = new Set(["visibilitychange"]);
const NODE_EVENTS = new Set([
  // mouse
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
  "contextmenu",
  // pointer
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerenter",
  "pointerleave",
  "pointerover",
  "pointerout",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  // keyboard
  "keydown",
  "keyup",
  "keypress",
  // focus
  "focus",
  "blur",
  "focusin",
  "focusout",
  // form
  "input",
  "change",
  "submit",
  "reset",
  // scroll / wheel / touch
  "scroll",
  "wheel",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  // animation / transition
  "animationstart",
  "animationend",
  "animationiteration",
  "transitionstart",
  "transitionend",
  "transitioncancel",
  "transitionrun",
  // media
  "load",
  "error",
  // synthetics (docs/design.md "Events")
  "mounted",
  "resize",
  "visible",
  "frame",
]);

export interface DesktopPolicyOptions {
  /** Custom-element tags the host registered as islands (docs/design.md
   * "Refs are ids; third-party DOM libraries need islands") — the only
   * hyphenated tags this policy admits. Lowercased at construction, since
   * every tag comparison here is lowercase. */
  islands?: string[];
  /** Allow a text (non-`asset`) `href` on `<a>` when it is a same-
   * document fragment (`#...`) or a same-origin absolute path (`/...`,
   * never `//...` — protocol-relative is a cross-origin URL wearing a
   * relative one's clothes). Judged by resolving the text against a
   * fixed placeholder origin with the real `URL` parser (not a regex),
   * so a backslash- or control-character-based origin override (a
   * browser normalizes leading `\` to `/` for special schemes) is caught
   * the same way a real navigation would see it. Default false: without
   * it every `href` must be an asset handle. */
  relativeHref?: boolean;
  /** Allow a text `href` on `<a>` (no namespace) whose value parses as an
   * absolute `http:`/`https:` URL. Default false. A producer may only
   * *name* such a link; whether the host actually follows it is a
   * separate decision made by the embedder's `on_navigation` handler
   * (host/desktop/src/main.rs), which is what makes this safe to turn
   * on for an untrusted producer instead of a policy hole. */
  externalLinks?: boolean;
  /** Allow the `style` attribute. Default false: denied like every other
   * unreviewed attribute — inline CSS is not a script vector by itself,
   * but `position: fixed; inset: 0` (or any full-viewport overlay) lets
   * an untrusted producer paint over the host's OWN chrome inside the
   * same privileged window, which is a spoofing primitive this policy
   * would otherwise be the only thing standing against. */
  inlineStyle?: boolean;
  /** Allow `query()` calls at all. Default true (allow); false disables
   * every query. */
  queries?: boolean;
  /** Node budget: counts `createElement` checks, including a template's
   * flattened synthetic ones (`registerTemplate` — see policy.ts's
   * `PolicySink`). Does NOT count nodes materialized by `cloneTemplate`:
   * `PolicyOp` has no clone-sized op (see the comment on budgets below),
   * so a producer that registers a small template and clones it
   * thousands of times under-counts against this ceiling. Default
   * 200_000. */
  maxNodes?: number;
  /** Listener budget: counts `addListener` checks. Default 50_000. */
  maxListeners?: number;
  /** Per-value cap, in UTF-8 bytes, on `setAttribute`'s text values AND
   * `setProperty`'s string values (`textContent`, `value`, ...).
   * `MAX_FRAME_BYTES` (frames.ts) already bounds one whole frame; this
   * bounds one string inside it, a separate ceiling with a much smaller
   * sane default. Default 64 KiB. */
  maxStringBytes?: number;
}

const DEFAULT_MAX_NODES = 200_000;
const DEFAULT_MAX_LISTENERS = 50_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

const utf8 = new TextEncoder();
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PLACEHOLDER_ORIGIN = "https://h.invalid";

function isSelfNs(ns: string | undefined, allowed: Set<string>): boolean {
  return ns === undefined || allowed.has(ns);
}

/** `relativeHref`'s rule: a same-document fragment, or a same-origin
 * absolute path — resolved with the real URL parser against a fixed
 * placeholder origin so `/\evil.example/x` (backslash normalized to `/`
 * for a special scheme, per the URL standard) resolves to the CROSS-
 * origin it actually navigates to and fails the check, the same way
 * `//evil.example` does. */
function isRelativeOk(text: string): boolean {
  if (CONTROL_CHARS.test(text)) return false;
  if (text.startsWith("#")) return true;
  if (!text.startsWith("/")) return false;
  try {
    return new URL(text, `${PLACEHOLDER_ORIGIN}/`).origin ===
      PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}

/** `externalLinks`'s rule: an absolute URL whose scheme is `http:` or
 * `https:`, parsed rather than matched by a scheme-prefix regex so a
 * control character or an unparseable value can't sneak past it. */
function isExternalOk(text: string): boolean {
  if (CONTROL_CHARS.test(text)) return false;
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build a fresh desktop `Policy`: a factory (not a singleton) because the
 * budgets below are per-mount counters, and one host process may mount
 * more than one untrusted producer.
 */
export function desktopPolicy(opts: DesktopPolicyOptions = {}): Policy {
  const islands = new Set((opts.islands ?? []).map((t) => t.toLowerCase()));
  const relativeHref = opts.relativeHref ?? false;
  const externalLinks = opts.externalLinks ?? false;
  const inlineStyle = opts.inlineStyle ?? false;
  const queriesAllowed = opts.queries ?? true;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const maxListeners = opts.maxListeners ?? DEFAULT_MAX_LISTENERS;
  const maxStringBytes = opts.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;

  // Budgets are cumulative for the life of this policy (one stream): a
  // `remove` is not credited back (PolicyOp has no remove op — policy.ts
  // — so there is nothing to observe), meaning a long-lived producer that
  // creates and removes nodes will eventually hit `maxNodes` even though
  // its live tree stays small. Acceptable for v1: correct-but-coarse
  // beats no ceiling at all, and a real budget needs the receiver to
  // report removals, which is future protocol surface, not this file.
  let nodes = 0;
  let listeners = 0;

  /** `length * 3 <= max` is UTF-16 code units, and UTF-8 never takes
   * more than 3 bytes per UTF-16 unit outside surrogate pairs (which
   * only shrink the ratio further) — so it rejects nothing `encode`
   * would accept, and skips the encode entirely for the overwhelmingly
   * common case of a value well under budget. */
  function checkStringLen(label: string, s: string): string | undefined {
    if (s.length * 3 <= maxStringBytes) return undefined;
    if (utf8.encode(s).length > maxStringBytes) {
      return `${label} exceeds maxStringBytes (${maxStringBytes})`;
    }
    return undefined;
  }

  function checkAttrValue(
    attrName: string,
    value: { kind: "text"; value: string } | { kind: "asset" } | undefined,
  ): string | undefined {
    if (value?.kind !== "text") return undefined;
    return checkStringLen(`attribute "${attrName}"`, value.value);
  }

  function check(op: PolicyOp): string | undefined {
    switch (op.op) {
      case "createElement": {
        nodes++;
        if (nodes > maxNodes) {
          return `node budget exceeded (maxNodes ${maxNodes})`;
        }
        const tag = op.tag.toLowerCase();
        if (tag.includes("-")) {
          return islands.has(tag)
            ? undefined
            : `custom element "${op.tag}" is not a registered island`;
        }
        if (DENIED_TAGS.has(tag) || !ELEMENT_TAGS.has(tag)) {
          return `element "${op.tag}" is not in the host vocabulary`;
        }
        if (!isSelfNs(op.ns, ELEMENT_NS)) {
          return `element "${op.tag}" has an unrecognized namespace`;
        }
        return undefined;
      }

      case "setAttribute": {
        const name = op.name.toLowerCase();
        if (name.startsWith("on")) {
          return `attribute "${op.name}" looks like an event handler`;
        }
        // Namespace, checked before anything name-specific (review
        // finding 7): a colon-bearing name must be one of the three
        // namespaced names this policy knows, and ANY name carrying a
        // non-undefined `ns` — colon or not — must be one of those same
        // three with the matching namespace URI, so `href` cannot sneak
        // through under a foreign namespace.
        if (name.includes(":") && !ALLOWED_NS_ATTRS.has(name)) {
          return `attribute "${op.name}" uses a namespace prefix outside xlink:href/xml:lang/xml:space`;
        }
        if (op.ns !== undefined) {
          if (!ALLOWED_NS_ATTRS.has(name) || !ATTR_NS.has(op.ns)) {
            return `attribute "${op.name}" has an unrecognized namespace`;
          }
        }
        if (name === "name") {
          return NAME_ALLOWED_TAGS.has(op.tag?.toLowerCase() ?? "")
            ? checkAttrValue(op.name, op.value)
            : `attribute "name" is not allowed on <${
              op.tag ?? "?"
            }> (DOM clobbering: a named form control becomes a document-global property)`;
        }
        if (name === "style") {
          return inlineStyle
            ? checkAttrValue(op.name, op.value)
            : `attribute "style" is not allowed (set opts.inlineStyle to allow)`;
        }
        if (URL_ATTRS.has(name)) {
          if (op.value?.kind === "asset") return undefined;
          const text = op.value?.kind === "text" ? op.value.value : undefined;
          const isAnchorHref = name === "href" && op.tag?.toLowerCase() === "a";
          if (isAnchorHref && text !== undefined) {
            if (relativeHref && isRelativeOk(text)) {
              return checkAttrValue(op.name, op.value);
            }
            if (externalLinks && isExternalOk(text)) {
              return checkAttrValue(op.name, op.value);
            }
          }
          return `attribute "${op.name}" must be an asset handle, not a text URL`;
        }
        if (
          !ALLOWED_ATTRS.has(name) && !name.startsWith("aria-") &&
          !name.startsWith("data-")
        ) {
          return `attribute "${op.name}" is not in the desktop attribute allowlist`;
        }
        return checkAttrValue(op.name, op.value);
      }

      case "setProperty": {
        const name = op.name;
        if (
          // native.ts's setProperty does `el[propName] = value` with no
          // guard against these; PROPERTY_ALLOWLIST already excludes
          // them too, so this is a second, explicitly named line of
          // defense rather than the allowlist's sole job.
          name.startsWith("on") || name === "__proto__" ||
          name === "constructor" || name === "prototype" ||
          !PROPERTY_ALLOWLIST.has(name)
        ) {
          return `property "${op.name}" is not in the host vocabulary`;
        }
        if (op.value.kind === "text") {
          return checkStringLen(`property "${op.name}"`, op.value.value);
        }
        return undefined;
      }

      case "addListener": {
        listeners++;
        if (listeners > maxListeners) {
          return `listener budget exceeded (maxListeners ${maxListeners})`;
        }
        const allowed = op.target === "window"
          ? WINDOW_EVENTS
          : op.target === "document"
          ? DOCUMENT_EVENTS
          : NODE_EVENTS;
        if (!allowed.has(op.name)) {
          return `event "${op.name}" is not allowed on target "${op.target}"`;
        }
        return undefined;
      }

      case "bindMarker":
        // Hydration has no place in the desktop story: a plugin has no
        // prerendered markup to claim (docs/design.md "Hydration is push,
        // and binds by marker").
        return "bindMarker is not supported for untrusted producers";
    }
  }

  function query(): boolean {
    return queriesAllowed;
  }

  return { version: PROTOCOL_VERSION, check, query };
}
