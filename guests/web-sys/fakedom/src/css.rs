//! The satellite objects hanging off a node: `classList`, `style`, and
//! the slice of CSSOM dominator needs.
//!
//! # Why there is a CSSOM here at all
//!
//! `DomBuilder::visible_signal` — which the TodoMVC port uses on every row
//! — toggles `HIDDEN_CLASS`, and that is a `class! { .style_important(
//! "display", "none") }` (dominator-0.5.38/src/dom.rs:85). Realising it
//! walks the whole CSSOM path: create a `<style>` element, append it to
//! `document.head`, read its `.sheet`, `insertRule`, then set properties on
//! the resulting rule's `.style`. So the fake has to carry a stylesheet
//! model, not just element styles.
//!
//! It resolves the way a browser would: the accumulated CSS text is
//! written back to the `<style>` element on every rule change, and that
//! element lives inside the mount root (see `Document::head` in the
//! `web-sys` shim). The receiver therefore gets real CSS in a real
//! `<style>` tag and `display: none` actually hides things.

use std::any::Any;
use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::{JsObject, JsValue};

use crate::dom;
use crate::node::NodeData;

/// `element.classList`.
pub struct DomTokenListObj {
    pub node: Rc<NodeData>,
}

impl JsObject for DomTokenListObj {
    fn class_chain(&self) -> &[&'static str] {
        &["DOMTokenList", "Object"]
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// One CSS rule in [`StyleSheetObj`]. Only style rules exist here;
/// dominator inserts nothing else.
pub struct StyleRuleObj {
    pub selector: String,
    pub decls: RefCell<Vec<(String, String)>>,
    sheet: RefCell<std::rc::Weak<StyleSheetObj>>,
    me: RefCell<std::rc::Weak<StyleRuleObj>>,
}

impl StyleRuleObj {
    /// The owning handle, recovered from a `&self` obtained by downcast.
    /// Same trick, same reason, as `NodeData::rc`.
    pub fn rc(&self) -> Rc<StyleRuleObj> {
        self.me
            .borrow()
            .upgrade()
            .expect("fakedom: rule self-reference outlived its allocation")
    }

    pub fn text(&self) -> String {
        let body = self
            .decls
            .borrow()
            .iter()
            .map(|(n, v)| format!("{n}: {v};"))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{} {{ {} }}", self.selector, body)
    }

    fn resync(&self) {
        if let Some(sheet) = self.sheet.borrow().upgrade() {
            sheet.resync();
        }
    }
}

impl JsObject for StyleRuleObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleRule", "CSSRule", "Object"]
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A `<style>` element's `.sheet`, doubling as its own `cssRules` list —
/// the two are always read together and nothing distinguishes them beyond
/// the class name.
pub struct StyleSheetObj {
    element: Rc<NodeData>,
    rules: RefCell<Vec<Rc<StyleRuleObj>>>,
    me: RefCell<std::rc::Weak<StyleSheetObj>>,
}

impl StyleSheetObj {
    pub fn new(element: Rc<NodeData>) -> Rc<StyleSheetObj> {
        let sheet = Rc::new(StyleSheetObj {
            element,
            rules: RefCell::new(Vec::new()),
            me: RefCell::new(std::rc::Weak::new()),
        });
        *sheet.me.borrow_mut() = Rc::downgrade(&sheet);
        sheet
    }

    pub fn rc(&self) -> Rc<StyleSheetObj> {
        self.me
            .borrow()
            .upgrade()
            .expect("fakedom: sheet self-reference outlived its allocation")
    }

    /// `cssRules.length`. Named for the DOM property, not for Rust's
    /// collection convention, so no `is_empty` companion.
    #[allow(clippy::len_without_is_empty)]
    pub fn len(&self) -> u32 {
        self.rules.borrow().len() as u32
    }

    pub fn rule(&self, index: u32) -> Option<Rc<StyleRuleObj>> {
        self.rules.borrow().get(index as usize).cloned()
    }

    /// `insertRule(text, index)`. Dominator only ever inserts
    /// `"<selector> {}"` (dominator-0.5.38/src/dom.rs:1709 builds the text
    /// with `format!("{} {{}}", rule)`), so a rule with a non-empty body
    /// would mean this shim's assumption has been outgrown.
    pub fn insert_rule(&self, text: &str, index: u32) -> Result<u32, JsValue> {
        let (selector, body) = text
            .split_once('{')
            .ok_or_else(|| JsValue::from_str("SyntaxError: rule has no block"))?;
        assert!(
            body.trim().trim_end_matches('}').trim().is_empty(),
            "fakedom: CSS rule bodies are not parsed; got {text:?}"
        );
        let rule = Rc::new(StyleRuleObj {
            selector: selector.trim().to_string(),
            decls: RefCell::new(Vec::new()),
            sheet: RefCell::new(self.me.borrow().clone()),
            me: RefCell::new(std::rc::Weak::new()),
        });
        *rule.me.borrow_mut() = Rc::downgrade(&rule);
        let index = (index as usize).min(self.rules.borrow().len());
        self.rules.borrow_mut().insert(index, rule);
        self.resync();
        Ok(index as u32)
    }

    /// Write the whole sheet back into its `<style>` element. The receiver
    /// then reparses it, exactly as a browser does when a script assigns
    /// `styleElement.textContent`.
    fn resync(&self) {
        let css = self
            .rules
            .borrow()
            .iter()
            .map(|r| r.text())
            .collect::<Vec<_>>()
            .join("\n");
        dom::set_text_content(&self.element, Some(&css));
    }
}

impl JsObject for StyleSheetObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleSheet", "StyleSheet", "CSSRuleList", "Object"]
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// What a `CssStyleDeclaration` is attached to: an element's inline
/// `style` attribute, or a stylesheet rule's block.
pub enum StyleTarget {
    Element(Rc<NodeData>),
    Rule(Rc<StyleRuleObj>),
}

pub struct StyleDeclObj {
    pub target: StyleTarget,
}

impl StyleDeclObj {
    pub fn get(&self, name: &str) -> String {
        match &self.target {
            StyleTarget::Element(node) => dom::style_get(node, name),
            StyleTarget::Rule(rule) => rule
                .decls
                .borrow()
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_default(),
        }
    }

    pub fn set(&self, name: &str, value: &str, important: bool) {
        match &self.target {
            StyleTarget::Element(node) => dom::style_set(node, name, value, important),
            StyleTarget::Rule(rule) => {
                let value = if important {
                    format!("{value} !important")
                } else {
                    value.to_string()
                };
                {
                    let mut decls = rule.decls.borrow_mut();
                    match decls.iter_mut().find(|(n, _)| *n == name) {
                        Some(slot) => slot.1 = value,
                        None => decls.push((name.to_string(), value)),
                    }
                }
                rule.resync();
            }
        }
    }

    pub fn remove(&self, name: &str) -> String {
        match &self.target {
            StyleTarget::Element(node) => dom::style_remove(node, name),
            StyleTarget::Rule(rule) => {
                let old = self.get(name);
                rule.decls.borrow_mut().retain(|(n, _)| n != name);
                rule.resync();
                old
            }
        }
    }
}

impl JsObject for StyleDeclObj {
    fn class_chain(&self) -> &[&'static str] {
        &["CSSStyleDeclaration", "Object"]
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
