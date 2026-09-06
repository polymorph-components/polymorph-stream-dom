//! [`MutationWriter`]: the `dioxus_core::WriteMutations` sink that turns
//! Dioxus's mutation vocabulary into `polymorph:stream-dom` frames.
//!
//! Ported from polyengine-dioxus's `src/writer.rs` (Apache-2.0, same
//! author), which wrote Dioxus's stack ops onto the wire verbatim. This
//! protocol does not have them: docs/design.md "Every op is addressable and
//! self-contained" requires every op to name its targets, so the stack
//! machine, the `m` counts and the stack-relative path ops are all resolved
//! *here*, producer-side. What survives the port is the template flattening
//! (two-pass intern-then-flatten, pointer-identity template key) and the
//! `event_bubbles` verdict on listener ops.
//!
//! Three pieces of bookkeeping do that resolution:
//!
//! - **Ids.** Dioxus `ElementId`s are slab indices and *are* reused; protocol
//!   node ids are never reused (proto/stream-dom.proto file header). So every
//!   ElementId assignment mints a fresh [`NodeId`] and the reverse entry of
//!   the id it displaced is dropped, which is what makes a stale
//!   `handle-event` for a removed node a clean "unknown id, drop".
//! - **Stack.** `stack: Vec<NodeId>` replays Dioxus's push/pop discipline so
//!   `append_children(id, m)` and kin become `m` explicit `insert-before`s.
//! - **Parents.** `insert-before` names a parent even when it has an anchor,
//!   and Dioxus never tells a renderer who the parent is (the browser's
//!   `insertBefore`/`replaceWith` do not need it). [`Location`] records, per
//!   node, either the parent it was inserted under or the (template root,
//!   path) it was cloned at, and [`MutationWriter::parent_of`] resolves the
//!   latter by binding the interior node lazily.
//!
//! This module deliberately names no WIT bindings, so `cargo test` can drive
//! a real `VirtualDom` through it natively (see `tests/writer_stream.rs`).

use std::cell::RefCell;
use std::rc::Rc;

use dioxus_core::{
    AttributeValue, ElementId, Template, TemplateAttribute, TemplateNode, WriteMutations,
};
use rustc_hash::FxHashMap;
use stream_dom_guest::{proto, Batch, Ids, Interner, NodeId, StrRef};

/// Where a node sits, which is what `insert-before`'s mandatory `parent`
/// needs and Dioxus never states.
#[derive(Clone, Debug)]
enum Location {
    /// Inserted (or about to be) directly under a known parent. `None` while
    /// the node is still detached — freshly cloned or created and only on the
    /// stack.
    Root { parent: Option<NodeId> },
    /// An interior node of the template clone rooted at `root`, reached by
    /// walking child indices `path`. Its parent is the node at `path[..n-1]`,
    /// or `root` itself when the path is one step long.
    InTemplate { root: NodeId, path: Vec<u8> },
}

/// Encodes Dioxus mutations as `polymorph:stream-dom` frames into a
/// [`Batch`].
///
/// The interner is shared (`Rc<RefCell<_>>`) with the event-dispatch path,
/// which needs the reverse `str-ref -> &str` lookup to turn a `handle-event`
/// name slot back into a Dioxus event name.
pub struct MutationWriter {
    /// The batch being filled. The driver drains it with [`Batch::finish`]
    /// once per flush and writes the bytes in one `channel::send`.
    pub batch: Batch,
    interner: Rc<RefCell<Interner>>,
    ids: Ids,
    /// `ElementId.0 -> NodeId`. Indexed, not hashed: Dioxus hands out slab
    /// indices densely from 0. `ElementId(0)` is the mount root, `NodeId` 0.
    el_to_node: Vec<Option<NodeId>>,
    /// The reverse, for `handle-event`. Only nodes that currently *are* the
    /// live binding of an ElementId appear here, so an event naming a
    /// displaced or removed id finds nothing and is dropped.
    node_to_el: FxHashMap<NodeId, ElementId>,
    /// Dioxus's renderer stack, resolved here rather than on the wire.
    stack: Vec<NodeId>,
    location: FxHashMap<NodeId, Location>,
    /// Interior template nodes that have been given an id, keyed by the clone
    /// root and the path walked from it. Populated by `assign_node_id` and by
    /// [`MutationWriter::bind_interior`]'s lazy binding.
    bound: FxHashMap<(NodeId, Vec<u8>), NodeId>,
    /// Ownership tree, for forgetting a whole subtree when its root is
    /// removed. Maintained wherever `location` is, and read only by
    /// [`MutationWriter::forget_subtree`]; see [`MutationWriter::link`] for
    /// why "owner" is not exactly "DOM parent".
    children: FxHashMap<NodeId, Vec<NodeId>>,
    /// Per-element style declarations. The protocol has one `style`
    /// attribute, not a style map, so Dioxus's per-property
    /// `set_attribute(name, ns = "style", ...)` accumulates here and is
    /// re-serialized whole on each change.
    styles: FxHashMap<NodeId, Vec<(String, String)>>,
    /// Guest-assigned template ids, keyed by the pointer identity of
    /// `Template`'s `roots`/`node_paths`/`attr_paths` slices — mirroring
    /// upstream `Template`'s own pointer-mode `Hash`/`PartialEq`
    /// (dioxus-core-0.7.10 src/nodes.rs:312-341). In builds that do not merge
    /// identical statics, two structurally identical `rsx!` sites register
    /// twice; a harmless duplicate registration for an O(1) lookup.
    templates: FxHashMap<(usize, usize, usize), u32>,
}

impl MutationWriter {
    /// Create a writer sharing `interner` with the event-dispatch path.
    pub fn new(interner: Rc<RefCell<Interner>>) -> Self {
        let mut node_to_el = FxHashMap::default();
        node_to_el.insert(0, ElementId(0));
        MutationWriter {
            batch: Batch::new(),
            interner,
            ids: Ids::new(),
            // ElementId(0) is the mount root, which is NodeId 0 by protocol.
            el_to_node: vec![Some(0)],
            node_to_el,
            stack: Vec::new(),
            location: FxHashMap::default(),
            bound: FxHashMap::default(),
            children: FxHashMap::default(),
            styles: FxHashMap::default(),
            templates: FxHashMap::default(),
        }
    }

    /// The ElementId currently bound to `node`, for `handle-event` routing.
    /// `None` for a node that was removed or whose ElementId has since been
    /// re-assigned — both of which the caller must treat as "drop the event".
    pub fn element_of(&self, node: NodeId) -> Option<ElementId> {
        self.node_to_el.get(&node).copied()
    }

    /// Mint a fresh `NodeId` for `el`, dropping the reverse entry of whatever
    /// id `el` was bound to before.
    ///
    /// Dioxus reuses ElementIds out of a slab; this protocol never reuses a
    /// node id. Overwriting the forward slot while dropping only the *old*
    /// id's reverse entry is what keeps a late event for the old node from
    /// landing on the new one.
    fn assign(&mut self, el: ElementId) -> NodeId {
        let nid = self.ids.alloc();
        if el.0 >= self.el_to_node.len() {
            self.el_to_node.resize(el.0 + 1, None);
        }
        if let Some(old) = self.el_to_node[el.0] {
            self.node_to_el.remove(&old);
        }
        self.el_to_node[el.0] = Some(nid);
        self.node_to_el.insert(nid, el);
        nid
    }

    /// Alias `el` to an already-allocated `nid` (the empty-path
    /// `assign_node_id` case: the "interior" node *is* the clone root).
    fn alias(&mut self, el: ElementId, nid: NodeId) {
        if el.0 >= self.el_to_node.len() {
            self.el_to_node.resize(el.0 + 1, None);
        }
        if let Some(old) = self.el_to_node[el.0] {
            if old != nid {
                self.node_to_el.remove(&old);
            }
        }
        self.el_to_node[el.0] = Some(nid);
        self.node_to_el.insert(nid, el);
    }

    /// The `NodeId` Dioxus's `ElementId` currently names.
    fn node(&self, el: ElementId) -> NodeId {
        self.el_to_node
            .get(el.0)
            .copied()
            .flatten()
            .unwrap_or_else(|| panic!("writer: no node id for {el:?}"))
    }

    fn forget(&mut self, nid: NodeId) {
        if let Some(el) = self.node_to_el.remove(&nid) {
            if self.el_to_node.get(el.0).copied().flatten() == Some(nid) {
                self.el_to_node[el.0] = None;
            }
        }
        // Unlink from whatever owns `nid`, and drop the `bound` entry if this
        // was a template interior — otherwise a later clone of the same
        // template at the same path would hand back a dead id.
        match self.location.remove(&nid) {
            Some(Location::Root { parent: Some(p) }) => self.unlink(p, nid),
            Some(Location::InTemplate { root, path }) => {
                self.bound.remove(&(root, path));
                self.unlink(root, nid);
            }
            Some(Location::Root { parent: None }) | None => {}
        }
        self.styles.remove(&nid);
        self.children.remove(&nid);
    }

    /// Forget `nid` and everything hanging off it.
    ///
    /// `Remove` frees the subtree's nodes receiver-side, so the producer must
    /// drop the whole subtree's bookkeeping — not just the root's. Leaving a
    /// descendant in `node_to_el` is not a harmless leak: its `ElementId` has
    /// been freed back into Dioxus's slab, so a late event for that node id
    /// would resolve to a live-but-unrelated `ElementId` and reach
    /// `runtime.handle_event` on the wrong node. That misroute is precisely
    /// what "ids are never reused" exists to prevent
    /// (proto/stream-dom.proto's file header), and it would defeat it.
    fn forget_subtree(&mut self, nid: NodeId) {
        let mut stack = vec![nid];
        while let Some(n) = stack.pop() {
            // Taken before `forget`, which would drop the list anyway. A
            // descendant's own `forget` then finds its parent's entry already
            // gone, so the unlink above is a no-op for everything but `nid`.
            if let Some(kids) = self.children.remove(&n) {
                stack.extend(kids);
            }
            self.forget(n);
        }
    }

    fn unlink(&mut self, owner: NodeId, child: NodeId) {
        if let Some(kids) = self.children.get_mut(&owner) {
            kids.retain(|&c| c != child);
        }
    }

    /// Record that `n` hangs off `owner` for the purposes of subtree
    /// forgetting, moving it out of any previous owner's list first.
    ///
    /// "Owner" is not quite "DOM parent": a template interior is owned by its
    /// clone *root*, because the root is the only id a `Remove` can name for
    /// that subtree. Nodes inserted under an interior are owned by the
    /// interior, so the chain root → interior → inserted still walks.
    ///
    /// Must run before `location` is updated — it reads the old location to
    /// find the previous owner.
    fn link(&mut self, n: NodeId, owner: NodeId) {
        match self.location.get(&n) {
            Some(Location::Root { parent: Some(p) }) if *p == owner => return,
            Some(Location::Root { parent: Some(p) }) => {
                let p = *p;
                self.unlink(p, n);
            }
            Some(Location::InTemplate { root, .. }) => {
                let root = *root;
                if root == owner {
                    return;
                }
                self.unlink(root, n);
            }
            Some(Location::Root { parent: None }) | None => {}
        }
        self.children.entry(owner).or_default().push(n);
    }

    fn intern(&mut self, s: &str) -> StrRef {
        self.interner.borrow_mut().intern(s, &mut self.batch)
    }

    fn intern_opt(&mut self, s: Option<&str>) -> Option<StrRef> {
        s.map(|s| self.intern(s))
    }

    /// Give the interior template node at `(root, path)` an id, emitting a
    /// `bind-path` for it if it does not have one yet.
    ///
    /// This is the lazy half of parent resolution: Dioxus only names the
    /// template interiors it needs (dynamic attributes, dynamic nodes), so an
    /// unnamed ancestor of a named node has no id until something — here, an
    /// `insert-before` under it — asks for one.
    fn bind_interior(&mut self, root: NodeId, path: &[u8]) -> NodeId {
        if let Some(&nid) = self.bound.get(&(root, path.to_vec())) {
            return nid;
        }
        let nid = self.ids.alloc();
        self.batch.bind_path(root, path, nid);
        self.bound.insert((root, path.to_vec()), nid);
        self.link(nid, root);
        self.location.insert(
            nid,
            Location::InTemplate {
                root,
                path: path.to_vec(),
            },
        );
        nid
    }

    /// The parent `insert-before` must name for a node the DOM would have
    /// found by itself.
    fn parent_of(&mut self, n: NodeId) -> NodeId {
        match self.location.get(&n).cloned() {
            Some(Location::Root { parent }) => parent.unwrap_or_else(|| {
                panic!("writer: node {n} has no parent yet; cannot resolve insert-before")
            }),
            Some(Location::InTemplate { root, path }) => {
                if path.len() <= 1 {
                    root
                } else {
                    self.bind_interior(root, &path[..path.len() - 1])
                }
            }
            None => panic!("writer: node {n} has no recorded location"),
        }
    }

    /// Pop the `m` nodes Dioxus just pushed, in the order it created them.
    fn pop(&mut self, m: usize) -> Vec<NodeId> {
        let at = self.stack.len() - m;
        self.stack.split_off(at)
    }

    /// Insert `nodes` under `parent` before `anchor`, recording the new
    /// parentage.
    fn insert(&mut self, parent: NodeId, nodes: &[NodeId], anchor: Option<NodeId>) {
        for &n in nodes {
            self.batch.insert_before(parent, n, anchor);
            self.link(n, parent);
            self.location.insert(
                n,
                Location::Root {
                    parent: Some(parent),
                },
            );
        }
    }

    /// The `NodeId` of the placeholder at `path` under the current stack top,
    /// binding it if this is the first time it has been named.
    ///
    /// Mirrors `assign_node_id`'s resolution, which the two path-addressed
    /// mutations share (`replace_placeholder_with_nodes` is the other).
    ///
    /// The empty path — "the placeholder *is* the clone root" — was not
    /// reproducible from any `rsx!` shape tried (root-level conditional,
    /// root-level component, either beside sibling roots): dioxus-core skips
    /// root-length paths in `load_placeholders`
    /// (dioxus-core-0.7.10 src/diff/node.rs:733, `if p.len() == 1 continue`)
    /// and returns the root's existing id from
    /// `assign_static_node_as_dynamic` (same file, :864). It is still handled
    /// rather than asserted away, because the alternative if it ever fires is
    /// emitting `bind-path(root, [], id)` — a bogus self-binding — rather
    /// than a loud failure.
    fn resolve_path(&mut self, root: NodeId, path: &[u8]) -> NodeId {
        if path.is_empty() {
            return root;
        }
        self.bind_interior(root, path)
    }

    // --- Templates ---

    /// Pass 1: intern every string the template references, so all their
    /// `Intern` frames precede the `RegisterTemplate` that names their slots
    /// (proto/stream-dom.proto: "An Intern precedes the first use of its
    /// slot").
    fn intern_template_node(&mut self, node: &TemplateNode) {
        if let TemplateNode::Element {
            tag,
            namespace,
            attrs,
            children,
        } = node
        {
            self.intern(tag);
            self.intern_opt(*namespace);
            for attr in *attrs {
                // Dynamic template attributes are realized later through
                // `set_attribute` on the `bind-path`'d node; only static ones
                // are part of the template.
                if let TemplateAttribute::Static {
                    name, namespace, ..
                } = attr
                {
                    self.intern(name);
                    self.intern_opt(*namespace);
                }
            }
            for child in *children {
                self.intern_template_node(child);
            }
        }
    }

    /// Pass 2: append `node` and its subtree to `nodes` in pre-order,
    /// returning `node`'s own index.
    ///
    /// The node is reserved in `nodes` *before* its children are walked (a
    /// `Dynamic` stands in), so the parent's index is fixed while the
    /// children take later slots. Must run after
    /// [`Self::intern_template_node`].
    fn flatten_template_node(
        &mut self,
        node: &TemplateNode,
        nodes: &mut Vec<proto::TemplateNode>,
    ) -> u32 {
        let kind = match node {
            TemplateNode::Element {
                tag,
                namespace,
                attrs,
                children,
            } => {
                let tag = self.intern(tag);
                let ns = self.intern_opt(*namespace);
                let mut out_attrs = Vec::new();
                for attr in *attrs {
                    if let TemplateAttribute::Static {
                        name,
                        value,
                        namespace,
                    } = attr
                    {
                        let name = self.intern(name);
                        let ns = self.intern_opt(*namespace);
                        out_attrs.push(proto::TemplateAttr {
                            name,
                            ns,
                            value: (*value).to_string(),
                        });
                    }
                }
                let index = nodes.len() as u32;
                // Reserved; overwritten below once the children are placed.
                nodes.push(proto::TemplateNode { kind: None });
                let children: Vec<u32> = children
                    .iter()
                    .map(|child| self.flatten_template_node(child, nodes))
                    .collect();
                nodes[index as usize] = proto::TemplateNode {
                    kind: Some(proto::template_node::Kind::Element(
                        proto::TemplateElement {
                            tag,
                            ns,
                            attrs: out_attrs,
                            children,
                        },
                    )),
                };
                return index;
            }
            TemplateNode::Text { text } => proto::template_node::Kind::Text((*text).to_string()),
            // A runtime-supplied node slot: clones as a placeholder the
            // producer later `insert-before`s against (proto/stream-dom.proto
            // `Dynamic`).
            TemplateNode::Dynamic { .. } => proto::template_node::Kind::Dynamic(proto::Dynamic {}),
        };
        let index = nodes.len() as u32;
        nodes.push(proto::TemplateNode { kind: Some(kind) });
        index
    }

    /// Return the id for `template`, registering it on first encounter.
    fn template_id(&mut self, template: Template) -> u32 {
        let key = (
            template.roots.as_ptr() as usize,
            template.node_paths.as_ptr() as usize,
            template.attr_paths.as_ptr() as usize,
        );
        if let Some(&id) = self.templates.get(&key) {
            return id;
        }
        let id = self.templates.len() as u32;
        self.templates.insert(key, id);

        for root in template.roots.iter() {
            self.intern_template_node(root);
        }
        let mut nodes = Vec::new();
        let roots = template
            .roots
            .iter()
            .map(|root| self.flatten_template_node(root, &mut nodes))
            .collect();
        self.batch
            .register_template(proto::RegisterTemplate { id, nodes, roots });
        id
    }
}

impl WriteMutations for MutationWriter {
    fn append_children(&mut self, id: ElementId, m: usize) {
        let parent = self.node(id);
        let nodes = self.pop(m);
        self.insert(parent, &nodes, None);
    }

    fn assign_node_id(&mut self, path: &'static [u8], id: ElementId) {
        // dioxus-core calls this with the root node on top of the stack
        // (dioxus-core-0.7.10 src/diff/node.rs:792 "IMPORTANT: This function
        // assumes that root node is the top node on the stack") and with the
        // leading root index already stripped (same file, line 871).
        let root = *self
            .stack
            .last()
            .expect("writer: assign_node_id on an empty stack");
        let nid = self.resolve_path(root, path);
        self.alias(id, nid);
    }

    fn create_placeholder(&mut self, id: ElementId) {
        let nid = self.assign(id);
        self.batch.create_placeholder(nid);
        self.location.insert(nid, Location::Root { parent: None });
        self.stack.push(nid);
    }

    fn create_text_node(&mut self, value: &str, id: ElementId) {
        let nid = self.assign(id);
        self.batch.create_text(nid, value);
        self.location.insert(nid, Location::Root { parent: None });
        self.stack.push(nid);
    }

    fn load_template(&mut self, template: Template, index: usize, id: ElementId) {
        let tmpl = self.template_id(template);
        let nid = self.assign(id);
        self.batch.clone_template(tmpl, index as u32, nid);
        self.location.insert(nid, Location::Root { parent: None });
        self.stack.push(nid);
    }

    fn replace_node_with(&mut self, id: ElementId, m: usize) {
        let old = self.node(id);
        let nodes = self.pop(m);
        let parent = self.parent_of(old);
        self.insert(parent, &nodes, Some(old));
        self.batch.remove(old);
        self.forget_subtree(old);
    }

    fn replace_placeholder_with_nodes(&mut self, path: &'static [u8], m: usize) {
        // The interpreter pops the `m` nodes *before* resolving the path
        // against the stack top (dioxus-interpreter-js-0.7.10
        // src/unified_bindings.rs:125-127, `replace_placeholder`), so the
        // clone root is what is left underneath.
        let nodes = self.pop(m);
        let root = *self
            .stack
            .last()
            .expect("writer: replace_placeholder_with_nodes on an empty stack");
        let old = self.resolve_path(root, path);
        let parent = self.parent_of(old);
        self.insert(parent, &nodes, Some(old));
        self.batch.remove(old);
        // `forget_subtree` drops the `bound` entry for `(root, path)` itself,
        // since the placeholder's own `location` records it.
        self.forget_subtree(old);
    }

    fn insert_nodes_after(&mut self, id: ElementId, m: usize) {
        // FRICTION (reported to the design record): the protocol has only
        // `insert-before`, and the anchor this needs is `id`'s *next
        // sibling*, which the producer does not know — the shadow tracks
        // parentage, not sibling order. Rather than carry a fully ordered
        // shadow tree (a child list per node, maintained on every insert,
        // move and remove) for this one op, insert the new nodes *before*
        // `id` and then move `id` back in front of them with one extra
        // `insert-before`. Net effect is identical; cost is one extra move op
        // per insert-after, and a receiver preferring `moveBefore` keeps the
        // moved node's state.
        let anchor = self.node(id);
        let nodes = self.pop(m);
        if nodes.is_empty() {
            return;
        }
        let parent = self.parent_of(anchor);
        self.insert(parent, &nodes, Some(anchor));
        self.batch.insert_before(parent, anchor, Some(nodes[0]));
    }

    fn insert_nodes_before(&mut self, id: ElementId, m: usize) {
        let anchor = self.node(id);
        let nodes = self.pop(m);
        let parent = self.parent_of(anchor);
        self.insert(parent, &nodes, Some(anchor));
    }

    fn set_attribute(
        &mut self,
        name: &'static str,
        ns: Option<&'static str>,
        value: &AttributeValue,
        id: ElementId,
    ) {
        let nid = self.node(id);

        // This table is dioxus-web's attribute-vs-property policy in
        // miniature (docs/design.md "`set-attribute` and `set-property` are
        // distinct": the producer decides, using the table its framework
        // already has). The authority is dioxus-interpreter-js-0.7.10
        // src/js/set_attribute.js (`setAttributeInner` / `setAttributeDefault`
        // / `truthy` / `isBoolAttr`) and the `remove_attribute` arm of
        // src/unified_bindings.rs, applied *after* `serialize` below has
        // reduced the value to a string exactly as dioxus's own renderer does.
        let Some(text) = serialize(value) else {
            return;
        };

        if ns == Some("style") {
            // The protocol carries one `style` attribute, not a style map, so
            // Dioxus's per-property writes accumulate and re-serialize whole.
            let entry = self.styles.entry(nid).or_default();
            match text {
                Some(v) => match entry.iter_mut().find(|(k, _)| k == name) {
                    Some(slot) => slot.1 = v,
                    None => entry.push((name.to_string(), v)),
                },
                None => entry.retain(|(k, _)| k != name),
            }
            let joined = entry
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join("; ");
            let style = self.intern("style");
            self.batch.set_attribute(nid, style, None, Some(&joined));
            return;
        }

        // `setAttributeInner`'s switch, arm for arm. Anything not named here
        // falls through to `setAttributeDefault`, i.e. a real attribute.
        //
        // Coercion matters: dioxus-web assigns `node.checked = truthy(value)`,
        // where `truthy` is `val === "true" || val === true`. Forwarding the
        // *string* "false" as a property instead would make the receiver
        // assign `el.checked = "false"`, which is truthy in JS — the exact bug
        // this table was rewritten to fix. Dioxus's TodoMVC writes
        // `checked: "{checked}"`, so `Text("false")` is the common case, not
        // an edge one.
        enum Prop {
            /// Assign the string as-is.
            Text(&'static str),
            /// Assign `truthy(value)` as a boolean.
            Bool(&'static str),
        }
        let prop = match name {
            // dioxus-web sets `value` as an *attribute* on `<option>` and as a
            // property everywhere else. Skipped: the writer does not know the
            // element's tag at set-attribute time (the tag is known when the
            // template is registered, not when a dynamic attribute is bound).
            // Harmless — `HTMLOptionElement.value`'s setter writes the content
            // attribute, so the property route reaches the same place.
            "value" => Some(Prop::Text("value")),
            "initial_value" => Some(Prop::Text("defaultValue")),
            "dangerous_inner_html" => Some(Prop::Text("innerHTML")),
            "checked" => Some(Prop::Bool("checked")),
            "initial_checked" => Some(Prop::Bool("defaultChecked")),
            "selected" => Some(Prop::Bool("selected")),
            "initial_selected" => Some(Prop::Bool("defaultSelected")),
            // NOT a property: `multiple` and `muted` are ordinary boolean
            // attributes in `isBoolAttr`, and go through the default arm
            // below. (dioxus-web additionally resets option selection after
            // writing `multiple`; that is receiver-side behavior, not a
            // different op.)
            _ => None,
        };
        if let Some(prop) = prop {
            let (prop, value) = match prop {
                Prop::Text(p) => (p, text.map(proto::set_property::Value::Text)),
                Prop::Bool(p) => (
                    p,
                    text.map(|s| proto::set_property::Value::Boolean(truthy(&s))),
                ),
            };
            // CONTRACT: `AttributeValue::None` becomes an absent `value` case,
            // which proto/stream-dom.proto's `SetProperty` defines as "deletes
            // / sets undefined". dioxus-web's `remove_attribute` is more
            // specific — `value` becomes `""` *and* the attribute is removed,
            // `checked`/`selected` become `false`, `innerHTML` becomes `""` —
            // and a receiver that literally assigns `undefined` gets the
            // string "undefined" in `el.value`, which is the same class of
            // JS-coercion bug as the one above. The conservative reading of
            // the schema is followed here; the receiver must treat an absent
            // value on these names as dioxus-web's reset, not as a raw
            // `undefined` assignment. Flagged in the track report.
            let name = self.intern(prop);
            self.batch.set_property(nid, name, value);
            return;
        }

        // `setAttributeDefault`: a falsy value on a boolean attribute removes
        // it; everything else is set to its string form verbatim (so a
        // non-boolean attribute really does get the literal "false").
        let text = text.filter(|v| truthy(v) || !is_bool_attr(name));
        // Intern first: the `Intern` frames must precede the `SetAttribute`
        // naming their slots.
        let name = self.intern(name);
        let ns = self.intern_opt(ns);
        self.batch.set_attribute(nid, name, ns, text.as_deref());
    }

    fn set_node_text(&mut self, value: &str, id: ElementId) {
        let nid = self.node(id);
        self.batch.set_text(nid, value);
    }

    fn create_event_listener(&mut self, name: &'static str, id: ElementId) {
        let nid = self.node(id);
        let slot = self.intern(name);
        self.batch.add_listener(proto::Listener {
            id: nid,
            name: slot,
            // The receiver delegates bubbling events at the mount root and
            // attaches non-bubbling ones per element, so it needs the
            // producer's verdict (proto/stream-dom.proto `Listener`).
            bubbles: dioxus_core_types::event_bubbles(name),
            capture: false,
            passive: false,
            // Dioxus handlers call `prevent_default` imperatively, which the
            // driver relays through `dom-event`; there is no declarative
            // verdict to publish at registration time.
            prevent_default: false,
            stop_propagation: false,
        });
    }

    fn remove_event_listener(&mut self, name: &'static str, id: ElementId) {
        let nid = self.node(id);
        let slot = self.intern(name);
        self.batch.remove_listener(proto::Listener {
            id: nid,
            name: slot,
            bubbles: dioxus_core_types::event_bubbles(name),
            capture: false,
            passive: false,
            prevent_default: false,
            stop_propagation: false,
        });
    }

    fn remove_node(&mut self, id: ElementId) {
        let nid = self.node(id);
        self.batch.remove(nid);
        self.forget_subtree(nid);
    }

    fn push_root(&mut self, id: ElementId) {
        let nid = self.node(id);
        self.stack.push(nid);
    }
}

/// Reduce an `AttributeValue` to the string dioxus's own renderer hands its
/// interpreter, before any attribute-vs-property decision is made
/// (dioxus-interpreter-js-0.7.10 src/write_native_mutations.rs
/// `set_attribute`): `Bool` becomes "true"/"false", numbers stringify, and
/// `AttributeValue::None` is the removal case (`Some(None)`).
///
/// Doing this first is what makes the table below a faithful port: by the
/// time `setAttributeInner` runs in a browser, *every* value is already a
/// string, which is why its `truthy` only has to test `val === "true"`.
///
/// `None` means there is nothing to put on the wire at all: `Listener`
/// reaches the renderer through `create_event_listener` instead, and `Any` is
/// a renderer-opaque payload for non-HTML renderers.
fn serialize(value: &AttributeValue) -> Option<Option<String>> {
    Some(match value {
        AttributeValue::Text(s) => Some(s.clone()),
        AttributeValue::Float(f) => Some(f.to_string()),
        AttributeValue::Int(n) => Some(n.to_string()),
        AttributeValue::Bool(b) => Some(if *b { "true" } else { "false" }.to_string()),
        AttributeValue::None => None,
        AttributeValue::Listener(_) | AttributeValue::Any(_) => return None,
    })
}

/// dioxus-web's `truthy` (dioxus-interpreter-js-0.7.10
/// src/js/set_attribute.js): after [`serialize`], only the literal string
/// "true" counts. Note this is *not* JS truthiness — "false" and "" are both
/// false here, and so is any other non-"true" string.
fn truthy(value: &str) -> bool {
    value == "true"
}

/// dioxus-web's `isBoolAttr` (dioxus-interpreter-js-0.7.10
/// src/js/set_attribute.js), copied verbatim. A falsy value on one of these
/// removes the attribute rather than setting it to "false".
fn is_bool_attr(field: &str) -> bool {
    matches!(
        field,
        "allowfullscreen"
            | "allowpaymentrequest"
            | "async"
            | "autofocus"
            | "autoplay"
            | "checked"
            | "controls"
            | "default"
            | "defer"
            | "disabled"
            | "formnovalidate"
            | "hidden"
            | "ismap"
            | "itemscope"
            | "loop"
            | "multiple"
            | "muted"
            | "nomodule"
            | "novalidate"
            | "open"
            | "playsinline"
            | "readonly"
            | "required"
            | "reversed"
            | "selected"
            | "truespeed"
            | "webkitdirectory"
    )
}
