//! `extern "C" { ... }` blocks: the whole job.
//!
//! Each `pub type` becomes a
//! [`wrapper_type!`](wasm_bindgen::wrapper_type) invocation, and each
//! `fn` becomes an ordinary Rust function whose body is one call on the
//! `JsObject` protocol. The mapping from binding attribute to protocol
//! call is the table in `wasm_bindgen::JsObject`'s doc comment; the
//! `js_name` defaulting mirrors
//! `wasm-bindgen-macro-support-0.2.128/src/parser.rs:1697` and
//! `.../src/ast.rs:708` (see [`op`]).

use proc_macro2::{Span, TokenStream};
use quote::{quote, quote_spanned};
use syn::spanned::Spanned;

use crate::attrs::Attrs;

pub fn expand(block: syn::ItemForeignMod) -> syn::Result<TokenStream> {
    let mut out = TokenStream::new();
    // Methods are grouped into one `impl` per receiver type, keyed by the
    // type's rendered tokens so `Element` and `::js_sys::Object` stay apart.
    let mut impls: Vec<(String, syn::Type, TokenStream)> = Vec::new();

    for item in block.items {
        match item {
            syn::ForeignItem::Type(ty) => out.extend(expand_type(ty)?),
            syn::ForeignItem::Fn(f) => {
                let (self_ty, tokens) = expand_fn(f)?;
                match self_ty {
                    None => out.extend(tokens),
                    Some(ty) => {
                        let key = quote!(#ty).to_string();
                        match impls.iter_mut().find(|(k, _, _)| *k == key) {
                            Some((_, _, body)) => body.extend(tokens),
                            None => impls.push((key, ty, tokens)),
                        }
                    }
                }
            }
            other => {
                return Err(syn::Error::new(
                    other.span(),
                    "wasm-bindgen fake: only `pub type` and `fn` items are supported in an \
                     `extern \"C\"` block",
                ))
            }
        }
    }

    for (_, ty, body) in impls {
        out.extend(quote! { impl #ty { #body } });
    }
    Ok(out)
}

/// `pub type Foo;` -> a `#[repr(transparent)]` wrapper over `JsValue`.
///
/// Everything a wrapper type needs (`JsCast`, the `AsRef`/`From` chain,
/// `Deref` to the first `extends`, `IntoJs`/`FromJs`) lives in
/// `wrapper_type!`, so this only computes the class name and the
/// ancestor list. `#[derive(...)]` is dropped: `wrapper_type!` already
/// emits `Clone`/`PartialEq`/`Eq` and a hand-written `Debug`, which is
/// exactly the set web-sys derives (`gen_Element.rs:8`), so passing it
/// through would be a duplicate impl.
fn expand_type(item: syn::ForeignItemType) -> syn::Result<TokenStream> {
    let (attrs, rust_attrs) = Attrs::take_from(item.attrs)?;
    let rust_attrs: Vec<_> = rust_attrs
        .into_iter()
        .filter(|a| !a.path().is_ident("derive"))
        .collect();

    let name = &item.ident;
    let vis = &item.vis;
    let class = attrs.string("js_name").unwrap_or_else(|| name.to_string());

    let extends = attrs
        .strings("extends")
        .into_iter()
        .map(|s| syn::parse_str::<syn::Type>(&s))
        .collect::<syn::Result<Vec<_>>>()?;

    Ok(if extends.is_empty() {
        quote! { ::wasm_bindgen::wrapper_type!(#(#rust_attrs)* #vis #name, #class); }
    } else {
        quote! { ::wasm_bindgen::wrapper_type!(#(#rust_attrs)* #vis #name, #class, extends: #(#extends),*); }
    })
}

/// Where a binding's generated function lives, and what it dispatches on.
enum Recv {
    /// `method`: an inherent method, `this: &T` becoming `&self`.
    Method(syn::Type),
    /// `constructor`: an inherent associated fn on the constructed type.
    Ctor { ty: syn::Type, class: String },
    /// `static_method_of = T`: an inherent associated fn reached through
    /// the global object under `namespace`.
    Static {
        ty: syn::Type,
        namespace: Vec<String>,
    },
    /// A free function, optionally under `js_namespace`.
    Free { namespace: Vec<String> },
}

/// Which protocol call the binding attributes select.
enum Op {
    Get(String),
    Set(String),
    IndexGet,
    IndexSet,
    IndexDel,
    Call(String),
}

fn expand_fn(item: syn::ForeignItemFn) -> syn::Result<(Option<syn::Type>, TokenStream)> {
    let span = item.sig.ident.span();
    let (attrs, rust_attrs) = Attrs::take_from(item.attrs)?;

    let sig = item.sig;
    let vis = item.vis;
    let ident = sig.ident.clone();
    let output = sig.output.clone();

    let mut inputs: Vec<(syn::Ident, syn::Type)> = Vec::new();
    for arg in &sig.inputs {
        let syn::FnArg::Typed(pat) = arg else {
            return Err(syn::Error::new(
                arg.span(),
                "wasm-bindgen fake: an `extern` binding takes no `self` receiver",
            ));
        };
        let syn::Pat::Ident(id) = &*pat.pat else {
            return Err(syn::Error::new(
                pat.pat.span(),
                "wasm-bindgen fake: binding arguments must be plain identifiers",
            ));
        };
        inputs.push((id.ident.clone(), (*pat.ty).clone()));
    }

    // Receiver, and the arguments that are actually lowered.
    let recv = classify(&attrs, &sig, &inputs)?;
    let args = if matches!(recv, Recv::Method(_)) {
        &inputs[1..]
    } else {
        &inputs[..]
    };

    let arg_decls = args.iter().map(|(n, t)| quote!(#n: #t));
    let self_arg = match recv {
        Recv::Method(_) => quote!(&self,),
        _ => quote!(),
    };

    let call = protocol_call(&recv, &op(&attrs, &ident)?, args, span)?;
    let body = if attrs.has("catch") {
        quote! { #call.map(::wasm_bindgen::__rt::FromJs::from_js) }
    } else {
        quote! {
            match #call {
                ::core::result::Result::Ok(__v) => ::wasm_bindgen::__rt::FromJs::from_js(__v),
                ::core::result::Result::Err(__e) => ::wasm_bindgen::__rt::uncaught(__e),
            }
        }
    };

    let tokens = quote_spanned! { span =>
        #(#rust_attrs)*
        #vis fn #ident(#self_arg #(#arg_decls),*) #output { #body }
    };

    Ok(match recv {
        Recv::Method(ty) | Recv::Ctor { ty, .. } | Recv::Static { ty, .. } => (Some(ty), tokens),
        Recv::Free { .. } => (None, tokens),
    })
}

fn classify(
    attrs: &Attrs,
    sig: &syn::Signature,
    inputs: &[(syn::Ident, syn::Type)],
) -> syn::Result<Recv> {
    if attrs.has("constructor") {
        let ty = constructed_type(&sig.output).ok_or_else(|| {
            syn::Error::new(
                sig.output.span(),
                "wasm-bindgen fake: a `constructor` binding must return the constructed type",
            )
        })?;
        let class = attrs
            .string("js_class")
            .or_else(|| last_segment(&ty))
            .ok_or_else(|| {
                syn::Error::new(ty.span(), "wasm-bindgen fake: cannot name this constructor")
            })?;
        return Ok(Recv::Ctor { ty, class });
    }
    if let Some(owner) = attrs.string("static_method_of") {
        let ty: syn::Type = syn::parse_str(&owner)?;
        // `parser.rs:1034` — `js_class` names the class, and failing that
        // the LAST segment of the `static_method_of` path, not the whole
        // path: `static_method_of = a::B` is `B` on the global.
        let class = attrs
            .string("js_class")
            .or_else(|| last_segment(&ty))
            .ok_or_else(|| {
                syn::Error::new(
                    ty.span(),
                    "wasm-bindgen fake: cannot name this static's class",
                )
            })?;
        return Ok(Recv::Static {
            ty,
            namespace: vec![class],
        });
    }
    if attrs.has("method") {
        let Some((_, ty)) = inputs.first() else {
            return Err(syn::Error::new(
                sig.span(),
                "wasm-bindgen fake: a `method` binding needs a `this: &T` first argument",
            ));
        };
        return Ok(Recv::Method(strip_ref(ty).clone()));
    }
    Ok(Recv::Free {
        namespace: attrs.namespace("js_namespace").unwrap_or_default(),
    })
}

/// The `js_name` defaulting rule, copied from the real parser.
///
/// `parser.rs:1697`: a function's JS name is `js_name` when given, else
/// the Rust identifier verbatim — there is **no** case conversion. For a
/// getter the property is `getter = "X"` when given, else that name
/// (`ast.rs:708`, `infer_getter_property`). For a setter it is
/// `setter = "X"`, else that name with its `set_` prefix removed
/// (`ast.rs:714`, `infer_setter_property`) — and since `parser.rs:1709`
/// prefixes a setter's `js_name` with `set_` before storing it, that
/// reduces to `js_name` whenever `js_name` is present.
fn op(attrs: &Attrs, ident: &syn::Ident) -> syn::Result<Op> {
    // `operation_kind` (parser.rs:3303) lets the indexing forms win.
    if attrs.has("indexing_getter") {
        return Ok(Op::IndexGet);
    }
    if attrs.has("indexing_setter") {
        return Ok(Op::IndexSet);
    }
    if attrs.has("indexing_deleter") {
        return Ok(Op::IndexDel);
    }
    let name = attrs.string("js_name").unwrap_or_else(|| ident.to_string());
    if attrs.has("getter") {
        return Ok(Op::Get(attrs.string("getter").unwrap_or(name)));
    }
    if attrs.has("setter") {
        let property = attrs
            .string("setter")
            .or_else(|| attrs.string("js_name"))
            .or_else(|| ident.to_string().strip_prefix("set_").map(str::to_owned))
            .ok_or_else(|| {
                syn::Error::new(
                    ident.span(),
                    format!("setters must start with `set_`, found: {ident}"),
                )
            })?;
        return Ok(Op::Set(property));
    }
    Ok(Op::Call(name))
}

/// The one expression a binding's body evaluates, of type
/// `Result<JsValue, JsValue>`.
fn protocol_call(
    recv: &Recv,
    op: &Op,
    args: &[(syn::Ident, syn::Type)],
    span: Span,
) -> syn::Result<TokenStream> {
    let lowered: Vec<_> = args
        .iter()
        .map(|(n, _)| quote!(::wasm_bindgen::__rt::IntoJs::into_js(#n)))
        .collect();
    let arity = |want: usize, what: &str| -> syn::Result<()> {
        if args.len() == want {
            Ok(())
        } else {
            Err(syn::Error::new(
                span,
                format!("wasm-bindgen fake: {what} takes {want} argument(s)"),
            ))
        }
    };

    // The receiver as a `&JsValue`: every wrapper type is `AsRef<JsValue>`.
    let this = quote! {
        ::core::convert::AsRef::<::wasm_bindgen::JsValue>::as_ref(self)
    };
    let key = |i: usize| {
        let n = &args[i].0;
        quote!(&::wasm_bindgen::__rt::ToString::to_string(&#n))
    };
    let ok_unit = quote!(.map(|()| ::wasm_bindgen::JsValue::UNDEFINED));

    Ok(match (recv, op) {
        (Recv::Ctor { class, .. }, _) => {
            quote! { ::wasm_bindgen::__rt::construct(#class, &[#(#lowered),*]) }
        }

        (Recv::Method(_), Op::Get(property)) => {
            arity(0, "a getter")?;
            quote! { ::wasm_bindgen::JsValue::get_prop(#this, #property) }
        }
        (Recv::Method(_), Op::Set(property)) => {
            arity(1, "a setter")?;
            let v = &lowered[0];
            quote! { ::wasm_bindgen::JsValue::set_prop(#this, #property, #v) #ok_unit }
        }
        (Recv::Method(_), Op::IndexGet) => {
            arity(1, "an indexing getter")?;
            let k = key(0);
            quote! { ::wasm_bindgen::JsValue::get_prop(#this, #k) }
        }
        (Recv::Method(_), Op::IndexSet) => {
            arity(2, "an indexing setter")?;
            let k = key(0);
            let v = &lowered[1];
            quote! { ::wasm_bindgen::JsValue::set_prop(#this, #k, #v) #ok_unit }
        }
        (Recv::Method(_), Op::IndexDel) => {
            arity(1, "an indexing deleter")?;
            let k = key(0);
            quote! {
                ::wasm_bindgen::JsValue::set_prop(#this, #k, ::wasm_bindgen::JsValue::UNDEFINED)
                #ok_unit
            }
        }
        (Recv::Method(_), Op::Call(method)) => {
            quote! { ::wasm_bindgen::JsValue::invoke(#this, #method, &[#(#lowered),*]) }
        }

        // Statics and free functions: walk the global to the namespace.
        (Recv::Static { namespace, .. } | Recv::Free { namespace }, Op::Call(method)) => {
            quote! { ::wasm_bindgen::__rt::call_static(&[#(#namespace),*], #method, &[#(#lowered),*]) }
        }
        // Every other operation reads or writes a property, which needs a
        // receiver that a static or free binding does not have.
        (Recv::Static { .. } | Recv::Free { .. }, _) => {
            return Err(syn::Error::new(
                span,
                "wasm-bindgen fake: a property binding needs a `this` receiver",
            ))
        }
    })
}

/// `&T` / `&mut T` -> `T`; anything else unchanged.
fn strip_ref(ty: &syn::Type) -> &syn::Type {
    match ty {
        syn::Type::Reference(r) => strip_ref(&r.elem),
        other => other,
    }
}

/// The type a `constructor` binding builds: its return type with any
/// `Result<_, _>` / `Option<_>` wrapper removed.
fn constructed_type(output: &syn::ReturnType) -> Option<syn::Type> {
    let syn::ReturnType::Type(_, ty) = output else {
        return None;
    };
    let mut ty = &**ty;
    while let syn::Type::Path(p) = ty {
        match inner_of(p, "Result").or_else(|| inner_of(p, "Option")) {
            Some(inner) => ty = inner,
            None => break,
        }
    }
    Some(ty.clone())
}

/// The first type argument of `Name<..>` when the path ends in `name`.
fn inner_of<'a>(path: &'a syn::TypePath, name: &str) -> Option<&'a syn::Type> {
    let last = path.path.segments.last()?;
    if last.ident != name {
        return None;
    }
    let syn::PathArguments::AngleBracketed(args) = &last.arguments else {
        return None;
    };
    args.args.iter().find_map(|a| match a {
        syn::GenericArgument::Type(t) => Some(t),
        _ => None,
    })
}

fn last_segment(ty: &syn::Type) -> Option<String> {
    match ty {
        syn::Type::Path(p) => Some(p.path.segments.last()?.ident.to_string()),
        _ => None,
    }
}
