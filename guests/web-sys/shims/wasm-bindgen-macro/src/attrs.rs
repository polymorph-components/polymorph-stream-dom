//! Permissive parsing of a `#[wasm_bindgen(...)]` attribute list.
//!
//! The real macro has a fixed, exhaustively-typed attribute grammar and
//! errors on anything it does not know. This one is deliberately lax: it
//! reads a comma-separated list of `key`, `key = <tokens>` entries and
//! lets the caller ask for the handful of keys that mean something here.
//! Unknown keys are silently ignored, because web-sys emits a dozen
//! attributes (`typescript_type`, `skip_jsdoc`, ...) whose whole meaning
//! is in the JS glue this shim does not generate.
//!
//! Values are kept as raw tokens up to the next top-level comma so that
//! `is_type_of = |_| false` (a closure expression, seen 72 times in
//! web-sys) parses like anything else.

use proc_macro2::{Delimiter, Ident, Spacing, TokenStream, TokenTree};
use quote::ToTokens;
use syn::spanned::Spanned;

pub struct Attrs {
    entries: Vec<(Ident, Option<TokenStream>)>,
}

impl Attrs {
    /// Parse one `(...)` attribute body.
    pub fn parse(tokens: TokenStream) -> syn::Result<Attrs> {
        let mut entries = Vec::new();
        let mut it = tokens.into_iter().peekable();
        loop {
            while matches!(it.peek(), Some(TokenTree::Punct(p)) if p.as_char() == ',') {
                it.next();
            }
            let key = match it.next() {
                None => break,
                Some(TokenTree::Ident(i)) => i,
                Some(other) => {
                    return Err(syn::Error::new(
                        other.span(),
                        "expected a `#[wasm_bindgen]` attribute name",
                    ))
                }
            };
            let mut value = None;
            let is_eq = matches!(it.peek(), Some(TokenTree::Punct(p))
                if p.as_char() == '=' && p.spacing() == Spacing::Alone);
            if is_eq {
                it.next();
                let mut toks = Vec::new();
                while let Some(t) = it.peek() {
                    if matches!(t, TokenTree::Punct(p) if p.as_char() == ',') {
                        break;
                    }
                    toks.push(it.next().expect("peeked"));
                }
                value = Some(toks.into_iter().collect());
            }
            entries.push((key, value));
        }
        Ok(Attrs { entries })
    }

    /// Collect every `#[wasm_bindgen(...)]` attribute on an item into one
    /// list, and return the item's other attributes untouched.
    pub fn take_from(attrs: Vec<syn::Attribute>) -> syn::Result<(Attrs, Vec<syn::Attribute>)> {
        let mut entries = Vec::new();
        let mut rest = Vec::new();
        for attr in attrs {
            if !attr.path().is_ident("wasm_bindgen") {
                rest.push(attr);
                continue;
            }
            match &attr.meta {
                syn::Meta::Path(_) => {}
                syn::Meta::List(list) => {
                    entries.extend(Attrs::parse(list.tokens.clone())?.entries);
                }
                syn::Meta::NameValue(nv) => {
                    return Err(syn::Error::new(
                        nv.span(),
                        "expected `#[wasm_bindgen(...)]`",
                    ))
                }
            }
        }
        Ok((Attrs { entries }, rest))
    }

    /// Refuse an attribute list in a position that has no use for one.
    /// `#[wasm_bindgen]` on an `extern "C"` block is bare throughout
    /// web-sys 0.3.105 -- every argument is on the items inside -- so a
    /// block-level argument is something this macro has never had to
    /// interpret, and guessing is worse than saying so.
    pub fn reject_arguments(&self, position: &str) -> syn::Result<()> {
        match self.entries.first() {
            None => Ok(()),
            Some((key, _)) => Err(syn::Error::new(
                key.span(),
                format!("wasm-bindgen fake: `{key}` is not supported on {position}"),
            )),
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    fn value(&self, key: &str) -> Option<&TokenStream> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.as_ref())
    }

    /// A value that is either a string literal or bare tokens, as a
    /// string. web-sys 0.3.105 writes `extends = "::js_sys::Object"` and
    /// `static_method_of = "VideoDecoder"` as literals; the real macro
    /// accepts bare paths, so both are read here.
    pub fn string(&self, key: &str) -> Option<String> {
        self.value(key).map(token_string)
    }

    /// Every value given for a repeated key, in source order. Only
    /// `extends` repeats (91 uses across web-sys, up to 5 on one type).
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(k, _)| k == key)
            .filter_map(|(_, v)| v.as_ref().map(token_string))
            .collect()
    }

    /// `js_namespace = "CSS"` or `js_namespace = ["a", "b"]`, both of
    /// which web-sys emits.
    pub fn namespace(&self, key: &str) -> Option<Vec<String>> {
        let tokens = self.value(key)?;
        let mut trees = tokens.clone().into_iter();
        if let (Some(TokenTree::Group(g)), None) = (trees.next(), trees.next()) {
            if g.delimiter() == Delimiter::Bracket {
                return Some(Attrs::parse_array(g.stream()));
            }
        }
        Some(vec![token_string(tokens)])
    }

    fn parse_array(inner: TokenStream) -> Vec<String> {
        inner
            .into_iter()
            .filter(|tt| !matches!(tt, TokenTree::Punct(p) if p.as_char() == ','))
            .map(|tt| token_string(&tt.into_token_stream()))
            .collect()
    }
}

/// A string literal's contents, or else the tokens rendered verbatim.
fn token_string(tokens: &TokenStream) -> String {
    if let Ok(lit) = syn::parse2::<syn::LitStr>(tokens.clone()) {
        return lit.value();
    }
    tokens.to_string().replace(' ', "")
}
