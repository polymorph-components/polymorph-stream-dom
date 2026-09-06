//! Dominator's TodoMVC `app.rs`. Changes from the original are marked
//! with `PORT:`; see the crate docs for why.

use dominator::traits::StaticEvent;
use dominator::{clone, events, html, text_signal, with_node, Dom, EventOptions};
use futures_signals::signal::{Mutable, Signal, SignalExt};
use futures_signals::signal_vec::{MutableVec, SignalVec, SignalVecExt};
use std::cell::Cell;
use std::sync::Arc;
use wasm_bindgen::JsCast;
use web_sys::HtmlInputElement;

use crate::todo::Todo;
use crate::util::trim;

/// PORT: `dominator::events` has no `hashchange`, so here is the same
/// `StaticEvent` impl its own macros generate (mirrors
/// dominator-0.5.38/src/events.rs `make_event!` + `static_event_impl!`).
/// This is what makes the filter links ordinary `<a href="#/...">` again:
/// the browser changes the hash, the receiver reports it, and the app
/// reads it here.
pub struct HashChange {
    event: web_sys::HashChangeEvent,
}

impl HashChange {
    #[inline]
    pub fn new_url(&self) -> String {
        self.event.new_url()
    }
}

impl StaticEvent for HashChange {
    const EVENT_TYPE: &'static str = "hashchange";

    #[inline]
    fn unchecked_from_event(event: web_sys::Event) -> Self {
        Self {
            event: event.unchecked_into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Active,
    Completed,
    All,
}

impl Route {
    /// PORT: the original used `web_sys::Url`, which a producer has no
    /// business owning. The hash suffix is all TodoMVC's routes are.
    pub fn from_url(url: &str) -> Self {
        match url.rfind('#').map(|i| &url[i..]) {
            Some("#/active") => Route::Active,
            Some("#/completed") => Route::Completed,
            _ => Route::All,
        }
    }

    pub fn to_url(&self) -> &'static str {
        match self {
            Route::Active => "#/active",
            Route::Completed => "#/completed",
            Route::All => "#/",
        }
    }
}

impl Default for Route {
    fn default() -> Self {
        // PORT: the original read the current URL at startup. A producer
        // has no `location` and the protocol has no read for it, so the
        // initial route is `All` and the first `hashchange` corrects it.
        // A receiver could close this by firing a synthetic `hashchange`
        // after the mount commits.
        Route::All
    }
}

#[derive(Debug)]
pub struct App {
    todo_id: Cell<u32>,
    new_todo_title: Mutable<String>,
    todo_list: MutableVec<Arc<Todo>>,
    route: Mutable<Route>,
}

impl App {
    pub fn new() -> Arc<Self> {
        Arc::new(App {
            todo_id: Cell::new(0),
            new_todo_title: Mutable::new("".to_owned()),
            todo_list: MutableVec::new(),
            route: Mutable::new(Route::default()),
        })
    }

    /// PORT: was `localStorage` persistence. `localStorage` is the host
    /// page's and the protocol has no op for it, so the app is in-memory.
    pub fn serialize(&self) {}

    pub fn route(&self) -> impl Signal<Item = Route> {
        self.route.signal()
    }

    fn create_new_todo(&self) {
        let mut title = self.new_todo_title.lock_mut();

        // Only create a new Todo if the text box is not empty
        if let Some(trimmed) = trim(&title) {
            let id = self.todo_id.get();
            self.todo_id.set(id + 1);

            self.todo_list
                .lock_mut()
                .push_cloned(Todo::new(id, trimmed.to_string()));

            *title = "".to_string();

            self.serialize();
        }
    }

    pub fn remove_todo(&self, todo: &Todo) {
        self.todo_list.lock_mut().retain(|x| **x != *todo);
    }

    fn remove_all_completed_todos(&self) {
        self.todo_list
            .lock_mut()
            .retain(|todo| todo.completed.get() == false);
    }

    fn set_all_todos_completed(&self, checked: bool) {
        for todo in self.todo_list.lock_ref().iter() {
            todo.completed.set_neq(checked);
        }

        self.serialize();
    }

    fn completed(&self) -> impl SignalVec<Item = bool> {
        self.todo_list
            .signal_vec_cloned()
            .map_signal(|todo| todo.completed.signal())
    }

    fn completed_len(&self) -> impl Signal<Item = usize> {
        self.completed().filter(|completed| *completed).len()
    }

    fn not_completed_len(&self) -> impl Signal<Item = usize> {
        self.completed().filter(|completed| !completed).len()
    }

    fn has_todos(&self) -> impl Signal<Item = bool> {
        self.todo_list
            .signal_vec_cloned()
            .len()
            .map(|len| len > 0)
            .dedupe()
    }

    fn render_header(app: Arc<Self>) -> Dom {
        html!("header", {
            .class("header")
            .children(&mut [
                html!("h1", {
                    .text("todos")
                }),

                html!("input" => HtmlInputElement, {
                    .focused(true)
                    .class("new-todo")
                    .attr("placeholder", "What needs to be done?")
                    .prop_signal("value", app.new_todo_title.signal_cloned())

                    .with_node!(element => {
                        .event(clone!(app => move |_: events::Input| {
                            app.new_todo_title.set_neq(element.value());
                        }))
                    })

                    .event_with_options(&EventOptions::preventable(), clone!(app => move |event: events::KeyDown| {
                        if event.key() == "Enter" {
                            event.prevent_default();
                            app.create_new_todo();
                        }
                    }))
                }),
            ])
        })
    }

    fn render_main(app: Arc<Self>) -> Dom {
        html!("section", {
            .class("main")

            .visible_signal(app.has_todos())

            .children(&mut [
                html!("input" => HtmlInputElement, {
                    .class("toggle-all")
                    .attr("id", "toggle-all")
                    .attr("type", "checkbox")
                    .prop_signal("checked", app.not_completed_len().map(|len| len == 0).dedupe())

                    .with_node!(element => {
                        .event(clone!(app => move |_: events::Change| {
                            app.set_all_todos_completed(element.checked());
                        }))
                    })
                }),

                html!("label", {
                    .attr("for", "toggle-all")
                    .text("Mark all as complete")
                }),

                html!("ul", {
                    .class("todo-list")
                    .children_signal_vec(app.todo_list.signal_vec_cloned()
                        .map(clone!(app => move |todo| Todo::render(todo, app.clone()))))
                }),
            ])
        })
    }

    // PORT: was `link!`, which routes through `history.pushState`. A plain
    // `<a href="#/...">` instead: the browser changes the hash itself and
    // the window `hashchange` listener on the root builder picks it up, so
    // there is no click handler at all.
    fn render_button(app: &Arc<Self>, text: &str, route: Route) -> Dom {
        html!("li", {
            .children(&mut [
                html!("a", {
                    .attr("href", route.to_url())
                    .text(text)
                    .class_signal("selected", app.route().map(move |x| x == route))
                })
            ])
        })
    }

    fn render_footer(app: Arc<Self>) -> Dom {
        html!("footer", {
            .class("footer")

            .visible_signal(app.has_todos())

            .children(&mut [
                html!("span", {
                    .class("todo-count")

                    .children(&mut [
                        html!("strong", {
                            .text_signal(app.not_completed_len().map(|len| len.to_string()))
                        }),

                        text_signal(app.not_completed_len().map(|len| {
                            if len == 1 {
                                " item left"
                            } else {
                                " items left"
                            }
                        })),
                    ])
                }),

                html!("ul", {
                    .class("filters")
                    .children(&mut [
                        Self::render_button(&app, "All", Route::All),
                        Self::render_button(&app, "Active", Route::Active),
                        Self::render_button(&app, "Completed", Route::Completed),
                    ])
                }),

                html!("button", {
                    .class("clear-completed")

                    // Show if there is at least one completed item.
                    .visible_signal(app.completed_len().map(|len| len > 0).dedupe())

                    .event(clone!(app => move |_: events::Click| {
                        app.remove_all_completed_todos();
                        app.serialize();
                    }))

                    .text("Clear completed")
                }),
            ])
        })
    }

    pub fn render(app: Arc<Self>) -> Dom {
        html!("section", {
            .class("todoapp")

            // PORT: the original subscribed to `routing::url()`. This is
            // the same thing one layer down -- a `hashchange` listener on
            // `window`, registered through Dominator's own `global_event`,
            // which the protocol now carries as a `Global(WINDOW)`
            // listener target.
            .global_event(clone!(app => move |e: HashChange| {
                app.route.set_neq(Route::from_url(&e.new_url()));
            }))

            .children(&mut [
                Self::render_header(app.clone()),
                Self::render_main(app.clone()),
                Self::render_footer(app.clone()),
            ])
        })
    }
}
