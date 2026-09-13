// Reentrancy guard for host->guest `handle-event` entries.
//
// The host may only enter the guest component instance when no guest
// activation is live. There are THREE windows in which a naive, synchronous
// dispatch from a DOM listener would violate that, and all three are
// reachable from ordinary app code:
//
//   1. A `handle-event` entry is synchronously active. The guest's own DOM
//      mutations (issued before the export parks or returns — e.g.
//      `replaceWith`ing a focused `<input>` out of the DOM) make the browser
//      fire a SECOND, synchronous native event (`focusout`/`blur`) while the
//      first entry is still on the stack. Entering the instance again there
//      is forbidden by the component model (observed: "Trap: cannot enter
//      component instance 0 (reentrance forbidden)").
//
//   2. A scheduler-driven mutation flush. When the guest re-renders off its
//      own timer/async work — no `handle-event` in flight at all — the
//      mutation batch arrives through the mutation stream's read session
//      (mount.ts's `stream.readDirect` callback resumption), and DOM
//      application happens synchronously INSIDE that resumption, i.e.
//      inside the guest's stream-write rendezvous. A live guest activation
//      is on the stack. So a native event fired by the mutation itself would
//      enter the guest from inside a live turn — the same trap, with no
//      `handle-event` entry active.
//
//   3. A host IMPORT invoked by the guest. `queries.set-focus`
//      (wit/stream-dom.wit, `interface queries`) runs host code while the
//      guest that called it is still on the stack, and `.focus()`/`.blur()`
//      fire `focusout`/`focusin` SYNCHRONOUSLY — delegated events this host
//      would otherwise dispatch straight back into that same live
//      activation. Same class as window 2 (host code running inside a
//      guest turn), reached from the other direction. The mechanism is
//      unchanged: mount.ts's `setFocus` brackets its body with
//      `beginApply`/`endApply`, so dispatches raised by the focus change
//      queue and drain once the guest's turn unwinds.
//
// Window 2 also risks a memory-safety hazard if guest code were run inside
// it: `stream.readDirect`'s callback holds a `DirectSource` view that
// aliases guest linear memory for the duration of the callback
// (contracts/embedder-api.md "Streams and futures", "Direct-access byte
// edges") — running guest code mid-application would both reenter the
// instance (forbidden) and observe or corrupt that view mid-copy, which is
// what the gate's bracket around the whole callback prevents.
//
// Why deferring to a microtask is sound: microtasks run only when the JS
// stack is empty, after the synchronous guest entry or direct-memory callback
// that caused the nested dispatch has returned. A drain deferred with
// `queueMicrotask` therefore runs outside that reentrant stack — no polling,
// no timers, and it lands at the earliest legal moment.
//
// A returned Promise is deliberately NOT a guard. In the plain callback
// runtime, an export's synchronous activation has parked before the call
// returns; JSPI supplies its own entry scheduling. Waiting for settlement
// needlessly delays newer browser input behind unrelated async work.
// Rejections are still observed.
//
// Caveat: `preventDefault` semantics are lost for DEFERRED dispatches. The
// browser has already decided whether to honor the default by the time the
// queued entry runs. This is inherent to any deferral (it was already true
// of the pre-existing in-flight queue). Declarative listener flags remain the
// answer for events that may be raised reentrantly or more than once in one JS
// task. The idle path stays synchronous precisely to keep `preventDefault`
// working for the common case, where the dispatch happens inside the native
// listener's own frame.

/**
 * Prevents a guest entry inside a forbidden synchronous window (see the
 * module comment: another entry's synchronous extent, mutation application
 * inside the read loop's resumption, or a host import running inside the
 * calling guest's turn).
 *
 * Pure logic — no DOM, no runtime imports — so the ordering rules can be
 * unit-tested directly. The host wraps mutation application AND the bodies
 * of guest-invoked imports in `beginApply`/`endApply`, and routes every DOM
 * event through `dispatch`.
 */
export class DispatchGate {
  /** A guest `handle-event` call has not yet returned to this host frame. */
  #entering = false;
  /** Inside a host-code window that runs within a live guest turn: the
   * mutation read session's chunk-application window (mount.ts's
   * `beginApply`/`endApply` around `stream.readDirect`'s callback), or the
   * body of a host import the guest called. */
  #applyDepth = 0;
  #disposed = false;
  /** Captured guest-entry thunks, drained FIFO. */
  #pending: Array<() => unknown> = [];
  #draining = false;
  #drainScheduled = false;
  #onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void) {
    this.#onError = onError;
  }

  /** Enter the mutation-application window: dispatches now queue. */
  beginApply(): void {
    this.#applyDepth++;
  }

  /** Leave the mutation-application window and drain what it collected.
   *
   * The drain is deferred with `queueMicrotask` rather than run inline:
   * `endApply` is called from the `finally` inside the read loop's chunk-application window,
   * which is still on the guest's rendezvous stack — the instance is not
   * enterable until that turn unwinds. An empty JS stack is the observable
   * proxy for "no live guest turn" (module comment). The same holds for a
   * host import's `finally`: it runs inside the caller's turn. */
  endApply(): void {
    if (this.#applyDepth === 0) {
      throw new Error("DispatchGate.endApply without matching beginApply");
    }
    this.#applyDepth--;
    if (this.#applyDepth === 0 && this.#pending.length > 0) {
      this.#scheduleDrain();
    }
  }

  /** Drop every queued entry and refuse further dispatches. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.length = 0;
  }

  /** Route a guest entry. `call` must have captured everything it needs
   * (payload, event wrapper) BEFORE being handed here: a queued entry runs
   * later, when the native event object may already be stale. */
  dispatch(call: () => unknown): void {
    if (this.#disposed) return;
    if (
      this.#entering || this.#applyDepth > 0 || this.#draining ||
      this.#pending.length > 0 || this.#drainScheduled
    ) {
      this.#pending.push(call);
      return;
    }
    // Idle: enter synchronously, so a `preventDefault()` made by the guest
    // still lands inside the native listener's frame.
    this.#enter(call);
  }

  #enter(call: () => unknown): void {
    // Queued thunks are cleared by `dispose`, so this is belt-and-braces —
    // but it documents the invariant: nothing enters the guest after
    // disposal.
    if (this.#disposed) return;
    this.#entering = true;
    let result: unknown;
    try {
      result = call();
    } catch (err) {
      this.#onError(err);
    } finally {
      this.#entering = false;
    }
    // Fire-and-forget from the listener's perspective. Promise settlement is
    // outside the protected synchronous turn; observe only rejection.
    void Promise.resolve(result).catch(this.#onError);
    if (this.#pending.length > 0) this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#draining || this.#disposed) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#disposed) {
      this.#pending.length = 0;
      return;
    }
    if (this.#entering || this.#applyDepth > 0 || this.#draining) return;
    this.#draining = true;
    try {
      // Deliberately drain to quiescence in this microtask. A handler may
      // synchronously append another event; FIFO puts it behind events already
      // queued. There is no arbitrary fairness budget in this first-spike
      // receiver: native event dispatch is finite, and an endless self-feeding
      // producer is already an endless synchronous workload.
      while (
        !this.#disposed && this.#applyDepth === 0 &&
        this.#pending.length > 0
      ) {
        this.#enter(this.#pending.shift()!);
      }
    } finally {
      this.#draining = false;
    }
    if (this.#pending.length > 0 && this.#applyDepth === 0) {
      this.#scheduleDrain();
    }
  }
}
