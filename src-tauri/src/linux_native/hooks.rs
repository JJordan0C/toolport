use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;

#[derive(Clone)]
pub(super) struct HooksPage {
    pub(super) root: gtk::Box,
    app: adw::Application,
    feedback: gtk::Label,
    enabled: gtk::Switch,
    summary: gtk::Label,
    profile_count: gtk::Label,
    profiles: gtk::Box,
    recent: gtk::Box,
    recent_count: gtk::Label,
    show_more_events: gtk::Button,
    /// The events behind the list, so expanding past the preview limit repaints
    /// from memory instead of re-reading the log.
    recent_data: Rc<RefCell<Vec<serde_json::Value>>>,
    show_all_recent: Rc<Cell<bool>>,
    preview: gtk::Button,
    refresh_button: gtk::Button,
    updating: Rc<Cell<bool>>,
}

/// Matches `RECENT_CALL_PREVIEW_LIMIT` on Activity, which shows ten and says so
/// rather than silently truncating the retained history.
const RECENT_EVENT_PREVIEW_LIMIT: usize = 10;

impl HooksPage {
    pub(super) fn new(app: &adw::Application) -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.add_css_class("toolport-content");
        let header = adw::HeaderBar::new();
        header.add_css_class("toolport-header");
        header.set_show_back_button(true);
        header.set_title_widget(Some(
            &gtk::Label::builder()
                .label("Agent activity")
                .css_classes(["title"])
                .build(),
        ));
        let refresh_button = gtk::Button::builder()
            .icon_name("view-refresh-symbolic")
            .tooltip_text("Refresh agent activity")
            .build();
        header.pack_end(&refresh_button);
        root.append(&header);

        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .build();
        let content = gtk::Box::new(gtk::Orientation::Vertical, 14);
        content.add_css_class("toolport-page");
        content.set_margin_top(20);
        content.set_margin_bottom(20);
        content.set_margin_start(20);
        content.set_margin_end(20);
        content.append(
            &gtk::Label::builder()
                .label("See what agents do outside the gateway")
                .halign(gtk::Align::Fill)
                .xalign(0.0)
                .wrap(true)
                .css_classes(["title-2"])
                .build(),
        );
        content.append(&muted("A content-free local recorder can capture session, tool, and folder metadata from Claude Code without seeing commands, files, or results."));
        let feedback = gtk::Label::builder()
            .halign(gtk::Align::Fill)
            .xalign(0.0)
            .wrap(true)
            .css_classes(["toolport-feedback"])
            .build();
        feedback.set_visible(false);
        content.append(&feedback);

        let recorder = gtk::Box::new(gtk::Orientation::Vertical, 0);
        recorder.add_css_class("toolport-settings-group");
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        row.add_css_class("toolport-setting-row");
        let copy = gtk::Box::new(gtk::Orientation::Vertical, 3);
        copy.set_hexpand(true);
        copy.append(&heading("Record what my agents do"));
        copy.append(&muted("Runs on session start, after native tools, and on session end. The recorder is not attached to the step that can block a call."));
        row.append(&copy);
        let enabled = gtk::Switch::builder().valign(gtk::Align::Center).build();
        row.append(&enabled);
        recorder.append(&row);
        let guarantees = gtk::Box::new(gtk::Orientation::Vertical, 5);
        guarantees.add_css_class("toolport-setting-row");
        guarantees.append(&guarantee("Cannot stop your agent"));
        guarantees.append(&guarantee("Stores no commands, file contents, or output"));
        guarantees.append(&guarantee(
            "Stays on this machine and removes only Toolport-owned hooks",
        ));
        recorder.append(&guarantees);
        content.append(&recorder);

        // Heading, count and the action that operates on the list, on one row.
        // The button used to sit above the count, between the section subtitle
        // and the list it previews.
        let profile_header = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        let profile_title = section_title(
            "Claude Code profiles",
            "Each profile needs the recorder separately. Unreadable files are reported, never overwritten.",
        );
        profile_title.set_hexpand(true);
        profile_header.append(&profile_title);
        let profile_count = gtk::Label::new(None);
        profile_count.add_css_class("toolport-badge");
        profile_count.set_valign(gtk::Align::Center);
        profile_count.set_visible(false);
        profile_header.append(&profile_count);
        let preview = gtk::Button::with_label("Preview exact hook changes");
        preview.set_valign(gtk::Align::Center);
        preview.add_css_class("toolport-secondary-action");
        profile_header.append(&preview);
        content.append(&profile_header);
        let summary = muted("Loading profiles…");
        content.append(&summary);
        let profiles = gtk::Box::new(gtk::Orientation::Vertical, 0);
        profiles.add_css_class("toolport-settings-group");
        content.append(&profiles);

        let recent_header = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        let recent_title = section_title(
            "Recorded so far",
            "The visible fields are the full retained record, not a redacted version of richer content.",
        );
        recent_title.set_hexpand(true);
        recent_header.append(&recent_title);
        let recent_count = gtk::Label::new(None);
        recent_count.add_css_class("toolport-badge");
        recent_count.set_valign(gtk::Align::Center);
        recent_count.set_visible(false);
        recent_header.append(&recent_count);
        let show_more_events = gtk::Button::with_label("Show all");
        show_more_events.set_valign(gtk::Align::Center);
        show_more_events.add_css_class("toolport-secondary-action");
        show_more_events.set_visible(false);
        recent_header.append(&show_more_events);
        content.append(&recent_header);
        let recent = gtk::Box::new(gtk::Orientation::Vertical, 0);
        recent.add_css_class("toolport-settings-group");
        content.append(&recent);

        scroller.set_child(Some(&content));
        root.append(&scroller);
        let page = Self {
            root,
            app: app.clone(),
            feedback,
            enabled,
            summary,
            profile_count,
            profiles,
            recent,
            recent_count,
            show_more_events,
            recent_data: Rc::new(RefCell::new(Vec::new())),
            show_all_recent: Rc::new(Cell::new(false)),
            preview,
            refresh_button,
            updating: Rc::new(Cell::new(false)),
        };
        page.connect();
        page
    }

    fn connect(&self) {
        let page = self.clone();
        self.refresh_button.connect_clicked(move |_| page.refresh());
        let page = self.clone();
        self.show_more_events.connect_clicked(move |_| {
            page.show_all_recent.set(!page.show_all_recent.get());
            page.render_recent(page.enabled.is_active());
        });
        let page = self.clone();
        self.enabled.connect_state_set(move |switch, enabled| {
            if page.updating.get() {
                return gtk::glib::Propagation::Proceed;
            }
            switch.set_sensitive(false);
            page.set_enabled(enabled);
            gtk::glib::Propagation::Stop
        });
        let page = self.clone();
        self.preview.connect_clicked(move |button| {
            button.set_sensitive(false);
            let button = button.clone();
            let page = page.clone();
            gtk::glib::spawn_future_local(async move {
                let result = gtk::gio::spawn_blocking(crate::hooks::preview).await;
                button.set_sensitive(true);
                match result {
                    Ok(Ok(previews)) => page.open_preview(previews),
                    Ok(Err(error)) => page.show_error(&error),
                    Err(_) => page.show_error("the recorder preview stopped unexpectedly"),
                }
            });
        });
    }

    pub(super) fn refresh(&self) {
        if self.updating.replace(true) {
            return;
        }
        self.refresh_button.set_sensitive(false);
        self.set_status("Loading agent activity…");
        let page = self.clone();
        gtk::glib::spawn_future_local(async move {
            let result = gtk::gio::spawn_blocking(|| {
                let view = crate::hooks::view();
                let recent = crate::hooks::read_recent(200)
                    .map_err(|error| format!("could not read agent activity: {error}"))?;
                Ok::<_, String>((view, recent))
            })
            .await;
            page.refresh_button.set_sensitive(true);
            match result {
                Ok(Ok((view, recent))) => {
                    page.render(view, recent);
                    // A load that worked is evident from the page rendering.
                    // Saying it in green left no room for the real outcomes,
                    // and read as reassurance while the recorder was off.
                    page.set_status("");
                }
                Ok(Err(error)) => {
                    page.updating.set(false);
                    page.show_error(&error);
                }
                Err(_) => {
                    page.updating.set(false);
                    page.show_error("the agent activity read stopped unexpectedly");
                }
            }
        });
    }

    /// Split out so the show-all toggle can repaint without another log read.
    fn render_recent(&self, enabled: bool) {
        let events = self.recent_data.borrow();
        let total = events.len();
        let visible = if self.show_all_recent.get() {
            total
        } else {
            total.min(RECENT_EVENT_PREVIEW_LIMIT)
        };
        // Say what is being held back. A silent cap reads as "this is everything".
        if total > 0 {
            self.recent_count.set_label(&if visible < total {
                format!("{visible} of {total}")
            } else {
                total.to_string()
            });
            self.recent_count.set_visible(true);
        } else {
            self.recent_count.set_visible(false);
        }
        self.show_more_events
            .set_visible(total > RECENT_EVENT_PREVIEW_LIMIT);
        self.show_more_events
            .set_label(if self.show_all_recent.get() {
                "Show fewer"
            } else {
                "Show all"
            });
        clear(&self.recent);
        let now = now_millis();
        for event in events.iter().take(visible) {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
            row.add_css_class("toolport-setting-row");
            // Every record carries `ts` and the list never showed it, so a run of
            // calls to one tool was twelve identical rows with no ordering signal.
            let age = event
                .get("ts")
                .and_then(serde_json::Value::as_u64)
                .map(|ts| relative_time(ts, now))
                .unwrap_or_else(|| "—".into());
            let age_label = gtk::Label::builder()
                .label(&age)
                .halign(gtk::Align::Start)
                .xalign(0.0)
                .width_chars(9)
                .css_classes(["toolport-muted"])
                .build();
            row.append(&age_label);
            let name = event
                .get("tool")
                .or_else(|| event.get("event"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let name_label = gtk::Label::builder()
                .label(name)
                .halign(gtk::Align::Start)
                .xalign(0.0)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .hexpand(true)
                .build();
            // Which hook this came from, without spending a column on it.
            if let Some(hook) = event.get("event").and_then(serde_json::Value::as_str) {
                name_label.set_tooltip_text(Some(hook));
            }
            row.append(&name_label);
            // Cursor guard rows carry the verdict the policy reached, which is the
            // entire point of observe mode. `agent_guard::record` writes them so
            // Agent activity can show them; only the React shell ever did.
            if let Some(badge) = guard_verdict_badge(event) {
                row.append(&badge);
            }
            let full_cwd = event.get("cwd").and_then(serde_json::Value::as_str);
            let cwd = full_cwd.and_then(folder_name).unwrap_or("—");
            let cwd_label = gtk::Label::new(Some(cwd));
            cwd_label.set_tooltip_text(full_cwd);
            row.append(&cwd_label);
            let full_session = event
                .get("sessionId")
                .or_else(|| event.get("session_id"))
                .and_then(serde_json::Value::as_str);
            let session = full_session
                .map(short_session)
                .unwrap_or_else(|| "—".into());
            let session_label = gtk::Label::new(Some(&session));
            session_label.set_tooltip_text(full_session);
            row.append(&session_label);
            self.recent.append(&row);
        }
        if self.recent.first_child().is_none() {
            self.recent.append(&padded(&muted(if enabled {
                "Nothing yet. Start a Claude Code session and events will appear here."
            } else {
                "Nothing recorded. Turn the recorder on to start."
            })));
        }
    }

    fn set_enabled(&self, enabled: bool) {
        if self.updating.replace(true) {
            return;
        }
        self.set_controls_sensitive(false);
        let page = self.clone();
        gtk::glib::spawn_future_local(async move {
            let result = gtk::gio::spawn_blocking(move || crate::hooks::set_enabled(enabled)).await;
            match result {
                Ok(Ok(view)) => {
                    let recent = gtk::gio::spawn_blocking(|| crate::hooks::read_recent(200)).await;
                    match recent {
                        Ok(Ok(recent)) => page.render(view, recent),
                        // `render` is the only thing that re-enables the
                        // controls, so a failed log read used to leave the
                        // switch, Preview and Refresh dead with no way back.
                        _ => {
                            page.set_controls_sensitive(true);
                            page.updating.set(false);
                        }
                    }
                    page.show_success(if enabled {
                        "Agent activity recording enabled."
                    } else {
                        "Agent activity recording disabled."
                    });
                }
                Ok(Err(error)) => {
                    page.updating.set(false);
                    page.show_error(&error);
                    page.refresh();
                }
                Err(_) => {
                    page.updating.set(false);
                    page.show_error("the recorder update stopped unexpectedly");
                    page.refresh();
                }
            }
        });
    }

    fn render(&self, view: crate::hooks::HooksView, recent: Vec<serde_json::Value>) {
        self.updating.set(true);
        super::settings::set_switch(&self.enabled, view.enabled);
        self.enabled
            .set_sensitive(view.enabled || view.binary.is_some());
        self.preview.set_sensitive(view.binary.is_some());
        clear(&self.profiles);
        let readable = view
            .profiles
            .iter()
            .filter(|profile| profile.error.is_none())
            .count();
        let installed = view
            .profiles
            .iter()
            .filter(|profile| profile.error.is_none() && profile.installed)
            .count();
        // "0 of 1 readable profiles carry the recorder" restated a single row
        // that already said "Off". The ratio is a badge on the heading now, and
        // the line below survives only for the cases the rows cannot cover.
        if readable > 0 {
            self.profile_count
                .set_label(&format!("{installed}/{readable}"));
            self.profile_count.set_tooltip_text(Some(&format!(
                "{installed} of {readable} readable profiles carry the recorder"
            )));
            self.profile_count.set_visible(true);
        } else {
            self.profile_count.set_visible(false);
        }
        let summary = if view.profiles.is_empty() {
            Some("No Claude Code profile found.")
        } else if readable == 0 {
            Some("No detected profile could be read.")
        } else {
            None
        };
        match summary {
            Some(text) => {
                self.summary.set_label(text);
                self.summary.set_visible(true);
            }
            None => self.summary.set_visible(false),
        }
        for profile in view.profiles {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
            row.add_css_class("toolport-setting-row");
            row.append(
                &gtk::Label::builder()
                    .label(&profile.path)
                    .halign(gtk::Align::Start)
                    .xalign(0.0)
                    .ellipsize(gtk::pango::EllipsizeMode::Middle)
                    .tooltip_text(&profile.path)
                    .hexpand(true)
                    .build(),
            );
            let status = gtk::Label::new(Some(if profile.error.is_some() {
                "Could not read"
            } else if profile.installed {
                "Recording"
            } else if view.enabled {
                "Not written yet"
            } else {
                "Off"
            }));
            status.set_tooltip_text(profile.error.as_deref());
            status.add_css_class(if profile.error.is_some() {
                "error"
            } else {
                "toolport-muted"
            });
            row.append(&status);
            self.profiles.append(&row);
        }
        if self.profiles.first_child().is_none() {
            self.profiles
                .append(&padded(&muted("No profiles to show.")));
        }

        *self.recent_data.borrow_mut() = recent;
        self.render_recent(view.enabled);
        self.refresh_button.set_sensitive(true);
        self.updating.set(false);
    }

    fn set_controls_sensitive(&self, sensitive: bool) {
        self.enabled.set_sensitive(sensitive);
        self.preview.set_sensitive(sensitive);
        self.refresh_button.set_sensitive(sensitive);
    }

    fn open_preview(&self, previews: Vec<crate::hooks::HooksPreview>) {
        let window = adw::Window::builder()
            .application(&self.app)
            .title("Agent recorder preview")
            .default_width(760)
            .default_height(620)
            .modal(true)
            .build();
        if let Some(parent) = self.app.active_window() {
            window.set_transient_for(Some(&parent));
        }
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let header = adw::HeaderBar::new();
        header.set_title_widget(Some(&gtk::Label::new(Some("What would be written"))));
        root.append(&header);
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .build();
        let content = gtk::Box::new(gtk::Orientation::Vertical, 12);
        content.add_css_class("toolport-dialog-content");
        if previews.is_empty() {
            content.append(&muted("No Claude Code profile was found."));
        }
        for preview in previews {
            content.append(&heading(&preview.path));
            let buffer = gtk::TextBuffer::new(None::<&gtk::TextTagTable>);
            buffer.set_text(&preview.error.unwrap_or(preview.after));
            let text = gtk::TextView::builder()
                .buffer(&buffer)
                .editable(false)
                .cursor_visible(false)
                .monospace(true)
                .wrap_mode(gtk::WrapMode::WordChar)
                .top_margin(10)
                .bottom_margin(10)
                .left_margin(10)
                .right_margin(10)
                .build();
            text.set_height_request(180);
            content.append(&text);
        }
        content.append(&muted(
            "Nothing has been written. Existing settings and comments stay intact.",
        ));
        scroller.set_child(Some(&content));
        root.append(&scroller);
        window.set_content(Some(&root));
        window.present();
    }

    /// An empty message hides the bar. `toolport-feedback` paints a background,
    /// so an empty label is a blank strip holding space.
    fn set_status(&self, message: &str) {
        self.feedback.set_label(message);
        self.feedback.set_visible(!message.is_empty());
        self.feedback.remove_css_class("error");
        self.feedback.remove_css_class("success");
    }

    fn show_success(&self, message: &str) {
        self.set_status(message);
        self.feedback.add_css_class("success");
    }

    fn show_error(&self, error: &str) {
        self.set_status(&format!("Agent activity error: {error}"));
        self.feedback.add_css_class("error");
    }
}

fn clear(container: &gtk::Box) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
}

fn heading(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .halign(gtk::Align::Fill)
        .xalign(0.0)
        .wrap(true)
        .css_classes(["heading"])
        .build()
}

fn muted(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .halign(gtk::Align::Fill)
        .xalign(0.0)
        .wrap(true)
        .css_classes(["toolport-muted"])
        .build()
}

fn padded(label: &gtk::Label) -> gtk::Label {
    label.set_margin_top(14);
    label.set_margin_bottom(14);
    label.set_margin_start(14);
    label.set_margin_end(14);
    label.clone()
}

fn section_title(title: &str, description: &str) -> gtk::Box {
    let section = gtk::Box::new(gtk::Orientation::Vertical, 3);
    section.append(&heading(title));
    section.append(&muted(description));
    section
}

fn guarantee(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(format!("✓  {text}"))
        .halign(gtk::Align::Fill)
        .xalign(0.0)
        .wrap(true)
        .css_classes(["toolport-muted"])
        .build()
}

fn folder_name(path: &str) -> Option<&str> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
}

fn short_session(session: &str) -> String {
    session.chars().take(8).collect()
}

/// The verdict a Cursor guard row should display: its label, the badge variant,
/// and the rule that decided it. `None` for an ordinary recorder event.
///
/// In observe mode the guard always answers "allow", so the useful fact is what
/// the rules WOULD have done: label and severity read from `wouldBe` there, and
/// from `decision` under enforce. Mirrors the React shell's guard row. Split from
/// the widget so it can be tested without a GTK display.
fn guard_verdict(
    event: &serde_json::Value,
) -> Option<(String, Option<&'static str>, Option<String>)> {
    let str_field = |key: &str| {
        event
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let decision = str_field("decision")?;
    let observing = str_field("mode").is_some_and(|mode| mode.eq_ignore_ascii_case("observe"));
    let would_be = str_field("wouldBe");
    let effective = if observing {
        would_be.clone().unwrap_or_else(|| "allow".into())
    } else {
        decision.clone()
    };
    let label = match (observing, would_be.as_deref()) {
        (true, Some(would)) if would != "allow" => format!("would {would}"),
        _ => decision,
    };
    let variant = match effective.as_str() {
        "deny" => Some("error"),
        "ask" => Some("review"),
        _ => None,
    };
    Some((label, variant, str_field("rule")))
}

fn guard_verdict_badge(event: &serde_json::Value) -> Option<gtk::Label> {
    let (label, variant, rule) = guard_verdict(event)?;
    let badge = gtk::Label::builder()
        .label(&label)
        .valign(gtk::Align::Center)
        .css_classes(["toolport-badge", "caption"])
        .build();
    if let Some(variant) = variant {
        badge.add_css_class(variant);
    }
    if let Some(rule) = rule {
        badge.set_tooltip_text(Some(&format!("rule {rule}")));
    }
    Some(badge)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Age of a record, from the epoch millis it was written with. Relative rather
/// than absolute because there is no date-formatting crate in this build, and
/// "4m ago" is the question a recent-activity list is actually asked. A record
/// stamped in the future (clock change) reads as "just now" rather than
/// underflowing.
fn relative_time(ts_millis: u64, now_millis: u64) -> String {
    let secs = now_millis.saturating_sub(ts_millis) / 1000;
    match secs {
        0..=9 => "just now".to_string(),
        10..=59 => format!("{secs}s ago"),
        60..=3_599 => format!("{}m ago", secs / 60),
        3_600..=86_399 => format!("{}h ago", secs / 3_600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;

    fn guard(mode: &str, decision: &str, would: Option<&str>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "event": "guard", "agent": "cursor", "mode": mode, "decision": decision,
            "rule": "Bash(rm -rf *)",
        });
        if let Some(w) = would {
            v["wouldBe"] = serde_json::json!(w);
        }
        v
    }

    /// Observe mode always answers allow, so the row has to show what the rules
    /// would have done instead, or the mode tells the user nothing.
    #[test]
    fn an_observed_guard_row_reports_what_the_rules_would_have_done() {
        let (label, variant, rule) =
            guard_verdict(&guard("observe", "allow", Some("deny"))).unwrap();
        assert_eq!(label, "would deny");
        assert_eq!(variant, Some("error"), "a would-deny reads as a refusal");
        assert_eq!(rule.as_deref(), Some("Bash(rm -rf *)"));
    }

    #[test]
    fn an_enforced_guard_row_reports_the_decision_it_actually_made() {
        let (label, variant, _) = guard_verdict(&guard("enforce", "deny", Some("deny"))).unwrap();
        assert_eq!(label, "deny");
        assert_eq!(variant, Some("error"));
        let (_, ask, _) = guard_verdict(&guard("enforce", "ask", Some("ask"))).unwrap();
        assert_eq!(ask, Some("review"));
    }

    #[test]
    fn an_observed_allow_is_not_dressed_up_as_a_refusal() {
        let (label, variant, _) = guard_verdict(&guard("observe", "allow", None)).unwrap();
        assert_eq!(label, "allow");
        assert_eq!(variant, None);
    }

    #[test]
    fn an_ordinary_recorder_event_gets_no_verdict_badge() {
        let row = serde_json::json!({"event": "PreToolUse", "tool": "Bash"});
        assert!(guard_verdict(&row).is_none());
    }

    #[test]
    fn relative_time_reads_at_each_scale() {
        let now = 10 * DAY;
        assert_eq!(relative_time(now, now), "just now");
        assert_eq!(relative_time(now - 9_000, now), "just now");
        assert_eq!(relative_time(now - 30_000, now), "30s ago");
        assert_eq!(relative_time(now - 4 * MIN, now), "4m ago");
        assert_eq!(relative_time(now - 3 * HOUR, now), "3h ago");
        assert_eq!(relative_time(now - 5 * DAY, now), "5d ago");
    }

    /// A record stamped ahead of the clock (a correction, or a timezone-confused
    /// writer) must not underflow into a nonsense age.
    #[test]
    fn a_future_timestamp_reads_as_just_now() {
        assert_eq!(relative_time(5 * DAY, 1 * DAY), "just now");
    }
}
