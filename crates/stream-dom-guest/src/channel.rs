//! The outgoing `stream<u8>` for this component instance.
//!
//! One producer per instance: [`open`] creates the stream once (from the
//! `run` export) and stores the writer half; [`send`] writes batches to
//! it, preserving order when a `send` arrives while another is already
//! in-flight by staging bytes for the in-flight sender to drain before it
//! hands the writer back. Ported from polyengine-dioxus's `driver.rs`
//! `flush` (lines 136-221): same staged-queue-behind-a-thread-local shape,
//! plain byte vectors instead of `Vec<Operation>` because this stream is
//! `stream<u8>` of encoded `Frame`s rather than a typed element stream
//! (docs/design.md "The channel is `stream<u8>` of op frames").

use std::cell::RefCell;

use wit_bindgen::rt::async_support::{StreamReader, StreamWriter};

use crate::bindings::wit_stream;

struct Channel {
    /// Taken for the duration of a write so a concurrent `send` can detect
    /// an in-flight write (sees `None`) instead of re-entering the writer.
    writer: Option<StreamWriter<u8>>,
    /// Bytes staged by a `send` that arrived while another held `writer`;
    /// drained, in order, by the in-flight sender before it hands the
    /// writer back — this is what keeps batches in wire order across
    /// concurrent senders.
    pending: Vec<u8>,
    /// Set once `write_all` reports a non-empty leftover (the host
    /// dropped the read end). Once dead, `send` drops its bytes instead
    /// of growing `pending` forever with no reader left to drain it.
    dead: bool,
}

thread_local! {
    static CHANNEL: RefCell<Option<Channel>> = const { RefCell::new(None) };
}

/// Create this instance's outgoing stream and store the writer half.
///
/// Panics if called twice: there is one producer, hence one outgoing
/// stream, per component instance.
pub fn open() -> StreamReader<u8> {
    let (writer, reader) = wit_stream::new();
    CHANNEL.with_borrow_mut(|c| {
        assert!(c.is_none(), "channel::open called twice on one instance");
        *c = Some(Channel {
            writer: Some(writer),
            pending: Vec::new(),
            dead: false,
        });
    });
    reader
}

/// Whether the host has dropped the read end. Once true, [`send`] is a
/// no-op.
pub fn is_dead() -> bool {
    CHANNEL.with_borrow(|c| c.as_ref().is_some_and(|c| c.dead))
}

/// Write `batch` to the outgoing stream, preserving order against any
/// other in-flight `send` on this instance.
pub async fn send(batch: Vec<u8>) {
    if batch.is_empty() {
        return;
    }

    enum Action {
        Write(StreamWriter<u8>, Vec<u8>),
        /// Another send is in flight; `batch` was appended to `pending`
        /// and will go out, in order, when that send drains it.
        Staged,
        Dead,
    }

    let action = CHANNEL.with_borrow_mut(|c| {
        let c = c
            .as_mut()
            .expect("channel::send called before channel::open");
        if c.dead {
            return Action::Dead;
        }
        match c.writer.take() {
            Some(w) => Action::Write(w, batch),
            None => {
                c.pending.extend(batch);
                Action::Staged
            }
        }
    });

    let (mut w, mut bytes) = match action {
        Action::Dead | Action::Staged => return,
        Action::Write(w, bytes) => (w, bytes),
    };

    loop {
        // `write_all` loops over partial writes internally; a non-empty
        // remainder means the read end is gone, not a short write to retry.
        let leftover = w.write_all(bytes).await;
        if !leftover.is_empty() {
            CHANNEL.with_borrow_mut(|c| {
                let c = c.as_mut().unwrap();
                c.dead = true;
                c.pending.clear();
            });
            return;
        }
        // Anything staged while we were awaiting must go out, in order,
        // before the writer becomes available to anyone else.
        let staged = CHANNEL.with_borrow_mut(|c| std::mem::take(&mut c.as_mut().unwrap().pending));
        if staged.is_empty() {
            CHANNEL.with_borrow_mut(|c| c.as_mut().unwrap().writer = Some(w));
            return;
        }
        bytes = staged;
    }
}
