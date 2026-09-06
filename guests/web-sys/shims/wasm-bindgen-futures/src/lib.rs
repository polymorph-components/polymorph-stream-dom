//! A fake `wasm-bindgen-futures`.
//!
//! Dominator spawns every signal subscription through `spawn_local`
//! (dominator-0.5.38/src/operations.rs:26), so this one function is the
//! whole reason the crate is patched. On the component target it forwards
//! to the component-model async runtime's task spawner — the same one the
//! sibling Dioxus driver uses (`crates/stream-dom-dioxus/src/driver.rs`).

/// Spawn a `'static` future on the current thread's executor.
#[cfg(target_arch = "wasm32")]
pub fn spawn_local<F>(future: F)
where
    F: std::future::Future<Output = ()> + 'static,
{
    wit_bindgen::rt::async_support::spawn_local(future);
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{run_pending, spawn_local};

/// Off the component target there is no runtime to borrow, so this is a
/// minimal single-threaded executor: tasks are queued, [`run_pending`]
/// polls the ready ones until nothing is ready, and wakers re-arm tasks
/// the way a real one does.
///
/// It exists so a native test can mount a real Dominator app, deliver
/// events to it and inspect the frames, rather than leaving "does it
/// actually run" to the browser. It is not a general executor: there is no
/// timer, no I/O, and `run_pending` returns as soon as the work settles.
#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Wake, Waker};

    type Task = Pin<Box<dyn Future<Output = ()>>>;

    /// The ready set. Behind a `Mutex` only because `Wake` requires
    /// `Send + Sync`; this executor is single-threaded.
    #[derive(Default)]
    struct Ready(Mutex<Vec<usize>>);

    struct TaskWaker {
        ready: Arc<Ready>,
        index: usize,
    }

    impl Wake for TaskWaker {
        fn wake(self: Arc<Self>) {
            self.ready.0.lock().unwrap().push(self.index);
        }
    }

    thread_local! {
        /// Slots, so a waker can name a task by index. `None` is a task
        /// that completed; slots are never reused, so a stale waker is a
        /// no-op rather than a wrong wake.
        static TASKS: RefCell<Vec<Option<Task>>> = const { RefCell::new(Vec::new()) };
        /// Spawned during a poll; adopted at the top of the next round so
        /// `TASKS` is not borrowed across user code.
        static PENDING: RefCell<Vec<Task>> = const { RefCell::new(Vec::new()) };
        static READY: Arc<Ready> = Arc::new(Ready::default());
    }

    pub fn spawn_local<F>(future: F)
    where
        F: Future<Output = ()> + 'static,
    {
        PENDING.with_borrow_mut(|p| p.push(Box::pin(future)));
    }

    /// Drive every ready task until the work settles.
    pub fn run_pending() {
        let ready = READY.with(Arc::clone);

        // Bounded so a task that wakes itself cannot hang a test.
        for _ in 0..100_000 {
            // Adopt anything spawned since the last round, ready to run.
            let fresh = PENDING.with_borrow_mut(std::mem::take);
            if !fresh.is_empty() {
                TASKS.with_borrow_mut(|tasks| {
                    let mut ready = ready.0.lock().unwrap();
                    for task in fresh {
                        ready.push(tasks.len());
                        tasks.push(Some(task));
                    }
                });
            }

            let Some(index) = ready.0.lock().unwrap().pop() else {
                return;
            };

            // Take the task out of its slot for the duration of the poll:
            // the future mutates the DOM, which can spawn or complete
            // other tasks, and a live borrow would panic.
            let Some(mut task) = TASKS.with_borrow_mut(|t| t[index].take()) else {
                continue;
            };
            let waker = Waker::from(Arc::new(TaskWaker {
                ready: Arc::clone(&ready),
                index,
            }));
            let done = task
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_ready();
            if !done {
                TASKS.with_borrow_mut(|t| t[index] = Some(task));
            }
        }
        panic!("wasm-bindgen-futures fake: run_pending did not settle");
    }
}
