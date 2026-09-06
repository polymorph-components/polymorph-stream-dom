//! A hand-written stand-in for `wasm-bindgen-macro`.
//!
//! The real `#[wasm_bindgen]` generates a wasm ABI boundary: descriptor
//! symbols, `#[link(wasm_import_module)]` shims and a JS glue file. There
//! is no such boundary here — a wasm *component* has no JS engine — so
//! this macro instead rewrites a binding onto the tiny dynamic-dispatch
//! protocol in `wasm_bindgen::JsObject`, whose doc comment is the
//! contract. Read that table before changing anything in
//! [`externs::expand`].
//!
//! It exists for exactly one consumer: the real, unmodified `web-sys`
//! 0.3.105 from crates.io. That crate uses `#[wasm_bindgen]` in exactly
//! two shapes, and so does this macro:
//!
//! * on an `extern "C"` block — its ~8000 generated bindings, handled by
//!   [`externs::expand`];
//! * on a string-discriminant `enum` (`ScrollBehavior` and kin), handled
//!   by [`string_enum`].
//!
//! Everything else a `#[wasm_bindgen]` can be attached to (`struct`,
//! `impl`, `fn`, `start`, a C-like `enum`) describes an *export* to JS,
//! which means nothing in a component: those items pass through with the
//! attribute stripped and nothing generated. Anything genuinely outside
//! the two shapes above — a `static` in an extern block, a block-level
//! argument list, a module-backed block — is a `compile_error!` naming
//! it, because a shim that guesses is worse than one that stops.

use proc_macro2::TokenStream;
use quote::{quote, ToTokens};

mod attrs;
mod externs;

use attrs::Attrs;

#[proc_macro_attribute]
pub fn wasm_bindgen(
    attr: proc_macro::TokenStream,
    item: proc_macro::TokenStream,
) -> proc_macro::TokenStream {
    expand(attr.into(), item.into())
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn expand(attr: TokenStream, item: TokenStream) -> syn::Result<TokenStream> {
    let outer = Attrs::parse(attr)?;
    match syn::parse2::<syn::Item>(item)? {
        syn::Item::ForeignMod(block) => {
            outer.reject_arguments("an `extern \"C\"` block")?;
            let (block_attrs, _) = Attrs::take_from(block.attrs.clone())?;
            block_attrs.reject_arguments("an `extern \"C\"` block")?;
            externs::expand(block)
        }
        syn::Item::Enum(e) if is_string_enum(&e) => string_enum(e),
        mut other => {
            strip(&mut other);
            Ok(other.into_token_stream())
        }
    }
}

fn is_string_enum(e: &syn::ItemEnum) -> bool {
    e.variants.iter().any(|v| {
        matches!(
            &v.discriminant,
            Some((
                _,
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(_),
                    ..
                })
            ))
        )
    })
}

/// `pub enum ScrollBehavior { Auto = "auto", .. }`
/// (`web-sys-0.3.105/src/features/gen_ScrollBehavior.rs:9`).
///
/// The discriminants are not valid Rust, so they are removed and become
/// the `IntoJs`/`FromJs` mapping instead. An unrecognised string panics:
/// the real bindings return `None` from a private `from_js_value`, but
/// nothing in this graph can observe that, and a silent wrong variant is
/// the failure mode the shim exists to avoid.
fn string_enum(e: syn::ItemEnum) -> syn::Result<TokenStream> {
    let mut names = Vec::new();
    let mut values = Vec::new();
    let mut variants = Vec::new();
    for v in &e.variants {
        let Some((
            _,
            syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }),
        )) = &v.discriminant
        else {
            return Err(syn::Error::new_spanned(
                v,
                "all variants of a string enum must have a string value",
            ));
        };
        names.push(v.ident.clone());
        values.push(s.value());
        variants.push(syn::Variant {
            discriminant: None,
            ..v.clone()
        });
    }

    let name = &e.ident;
    let vis = &e.vis;
    let attrs = &e.attrs;
    let unknown = format!("wasm-bindgen fake: not a {name} value: ");
    Ok(quote! {
        #(#attrs)*
        #vis enum #name { #(#variants),* }

        impl ::wasm_bindgen::__rt::IntoJs for #name {
            fn into_js(self) -> ::wasm_bindgen::JsValue {
                ::wasm_bindgen::JsValue::from_str(match self {
                    #( #name::#names => #values, )*
                })
            }
        }

        impl ::wasm_bindgen::__rt::IntoJs for &#name {
            fn into_js(self) -> ::wasm_bindgen::JsValue {
                ::wasm_bindgen::__rt::IntoJs::into_js(*self)
            }
        }

        impl ::wasm_bindgen::__rt::FromJs for #name {
            fn from_js(v: ::wasm_bindgen::JsValue) -> #name {
                let s = <::wasm_bindgen::__rt::String as ::wasm_bindgen::__rt::FromJs>::from_js(v);
                match &*s {
                    #( #values => #name::#names, )*
                    other => ::core::panic!("{}{}", #unknown, other),
                }
            }
        }

        impl From<#name> for ::wasm_bindgen::JsValue {
            fn from(v: #name) -> ::wasm_bindgen::JsValue {
                ::wasm_bindgen::__rt::IntoJs::into_js(v)
            }
        }
    })
}

/// Drop `#[wasm_bindgen(..)]` from an item and everything inside it.
fn strip(item: &mut syn::Item) {
    match item {
        syn::Item::Struct(s) => {
            strip_attrs(&mut s.attrs);
            for f in &mut s.fields {
                strip_attrs(&mut f.attrs);
            }
        }
        syn::Item::Enum(e) => {
            strip_attrs(&mut e.attrs);
            for v in &mut e.variants {
                strip_attrs(&mut v.attrs);
                for f in &mut v.fields {
                    strip_attrs(&mut f.attrs);
                }
            }
        }
        syn::Item::Impl(i) => {
            strip_attrs(&mut i.attrs);
            for it in &mut i.items {
                match it {
                    syn::ImplItem::Fn(f) => strip_attrs(&mut f.attrs),
                    syn::ImplItem::Const(c) => strip_attrs(&mut c.attrs),
                    syn::ImplItem::Type(t) => strip_attrs(&mut t.attrs),
                    _ => {}
                }
            }
        }
        syn::Item::Fn(f) => strip_attrs(&mut f.attrs),
        syn::Item::Mod(m) => {
            strip_attrs(&mut m.attrs);
            if let Some((_, items)) = &mut m.content {
                items.iter_mut().for_each(strip);
            }
        }
        _ => {}
    }
}

fn strip_attrs(attrs: &mut Vec<syn::Attribute>) {
    attrs.retain(|a| !a.path().is_ident("wasm_bindgen"));
}
