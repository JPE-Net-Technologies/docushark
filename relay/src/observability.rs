//! Optional error reporting to a Sentry-compatible endpoint.
//!
//! ## Off unless an operator turns it on
//!
//! The relay is AGPL and self-hostable. Nobody running their own relay should
//! acquire a telemetry dependency by upgrading, so this is **inert without
//! `SENTRY_DSN`**: no DSN, no client, no panic hook, no network. There is no
//! default endpoint compiled in, and there must never be one — the operator
//! supplies their own DSN or gets nothing.
//!
//! ## What it captures, and what it deliberately does not
//!
//! - **Errors**: a `log::error!` becomes an event.
//! - **Panics**: the panic hook captures, including panics the WS layer catches
//!   at its isolation boundary — the hook runs before unwinding finishes, so an
//!   isolated panic is still reported rather than silently absorbed.
//! - **Breadcrumbs**: `info` and above are attached to whatever event fires
//!   next, which costs nothing until something actually breaks. This is the part
//!   that makes an event diagnosable — an error alone rarely says what led to it.
//!
//! Deliberately absent: performance tracing (measured dead on the Worker side
//! and removed there, and a single-process authoritative relay pays for spans
//! on its hot path), and release health / sessions (a second concept to reason
//! about, for a long-lived server process where "crash-free rate" is close to
//! meaningless).
//!
//! **`warn!` is NOT captured as an event, on purpose.** Normal operation emits
//! warnings that are expected and not incidents — a truncated import, a blob
//! host that is not on the allowlist. Capturing them all would bury the real
//! events and burn quota. When a warning *is* an incident, the fix is to raise
//! that call site to `error!`, not to widen the net: a durable-write failure
//! logged at `warn` is a mis-levelled log, and blanket capture would paper over
//! that rather than fix it.
//!
//! ## Scrubbing
//!
//! Server logs are not user content, but they do carry workspace and document
//! ids, and a bearer token must never reach a third party. `before_send` drops
//! any event whose message looks like it carries a credential, rather than
//! trying to redact in place — a partial redaction that misses is worse than a
//! dropped event.

use std::borrow::Cow;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::build_info;

/// Held for the lifetime of the process. Dropping it flushes pending events and
/// disables the client, so `main` must keep it alive — a `let _ = init()` here
/// would disable reporting on the very next line, which is the classic way to
/// wire this up and see nothing arrive.
pub type SentryGuard = sentry::ClientInitGuard;

/// Substrings that mark a log line as carrying something we will not transmit.
/// Matched case-insensitively against the event message.
const CREDENTIAL_MARKERS: [&str; 6] = [
    "authorization:",
    "bearer ",
    "secret",
    "password",
    "private_key",
    "set-cookie",
];

fn looks_like_credential(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    CREDENTIAL_MARKERS.iter().any(|m| lower.contains(m))
}

/// True when the event carries something that must not leave the process.
///
/// Both message shapes must be checked. `sentry-log` — the bridge that produces
/// almost every event this relay sends — populates **`logentry`**, not
/// `message`; `message` is what a hand-built `capture_message` sets. Testing
/// only the latter leaves the production shape unguarded, which is exactly what
/// the first version of this did.
pub fn event_is_unsafe_to_send(event: &sentry::protocol::Event<'static>) -> bool {
    if let Some(msg) = event.message.as_deref() {
        if looks_like_credential(msg) {
            return true;
        }
    }
    event.logentry.as_ref().is_some_and(|le| looks_like_credential(&le.message))
}

/// The `before_send` hook: drop an unsafe event, pass everything else through.
///
/// A named function rather than a closure so the wiring below is a single
/// reference with no logic of its own — an inline closure can quietly drift
/// from the function the tests actually exercise.
pub fn scrub_event(
    event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    if event_is_unsafe_to_send(&event) {
        None
    } else {
        Some(event)
    }
}

/// `<version>+<sha>` — matches what `/version` and `relay_build_info` report, so
/// an event can be tied back to an exact binary without a second lookup.
pub fn release_name() -> String {
    format!("{}+{}", build_info::VERSION, build_info::GIT_SHA)
}

/// Read the deployment environment. `SENTRY_ENVIRONMENT` wins; otherwise the
/// region the relay was told it is serving (`RELAY_REGION`), which is already
/// set on every deployed pod. Falls back to `unknown` rather than guessing
/// `production` — mislabelling a staging event as production is worse than
/// leaving it unlabelled.
pub fn environment_name() -> String {
    std::env::var("SENTRY_ENVIRONMENT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("RELAY_REGION").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Initialize error reporting, or return `None` when no DSN is configured.
///
/// Call this **before** the Tokio runtime is built: the transport spawns its own
/// worker, and the panic hook should be installed before any task can run.
pub fn init() -> Option<SentryGuard> {
    let dsn = std::env::var("SENTRY_DSN").ok().filter(|d| !d.trim().is_empty())?;

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(Cow::Owned(release_name())),
            environment: Some(Cow::Owned(environment_name())),
            // The panic integration is on by default; spelled out because the
            // WS layer catches panics at its isolation boundary and the whole
            // point is that those still get reported.
            attach_stacktrace: true,
            before_send: Some(std::sync::Arc::new(|event| scrub_event(event))),
            ..Default::default()
        },
    ));

    // Callers must install their logger BEFORE calling this, or this line —
    // the only runtime evidence that reporting is on — goes nowhere. See the
    // ordering note in main.rs.
    log::info!(
        "sentry error reporting enabled (release {}, environment {})",
        release_name(),
        environment_name()
    );
    Some(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_with_message(msg: &str) -> sentry::protocol::Event<'static> {
        sentry::protocol::Event {
            message: Some(msg.to_string()),
            ..Default::default()
        }
    }

    /// The shape `sentry-log` actually produces — `logentry`, not `message`.
    fn event_with_logentry(msg: &str) -> sentry::protocol::Event<'static> {
        sentry::protocol::Event {
            logentry: Some(sentry::protocol::LogEntry {
                message: msg.to_string(),
                params: vec![],
            }),
            ..Default::default()
        }
    }

    #[test]
    fn ordinary_messages_are_sent() {
        assert!(!event_is_unsafe_to_send(&event_with_message(
            "R2 PUT docs/ws-1/docs/doc-1.json -> 403 Forbidden"
        )));
        assert!(!event_is_unsafe_to_send(&event_with_message(
            "blob s3 put failed ws-1/abc123"
        )));
    }

    #[test]
    fn credential_bearing_messages_are_dropped() {
        for msg in [
            "authorization: Bearer eyJhbGciOi",
            "Bearer eyJhbGciOiJSUzI1NiJ9.payload",
            "RELAY_R2_SECRET_ACCESS_KEY=abc",
            "password=hunter2",
            "set-cookie: session=abc",
        ] {
            assert!(
                event_is_unsafe_to_send(&event_with_message(msg)),
                "should have been dropped: {msg}"
            );
        }
    }

    // --- The logentry shape: this is what the log bridge emits, so these are
    // the cases that matter in production. The message-only tests above cover
    // hand-built `capture_message` calls.

    #[test]
    fn a_credential_in_a_LOGENTRY_is_dropped() {
        assert!(event_is_unsafe_to_send(&event_with_logentry(
            "auth failed for authorization: Bearer eyJhbGciOi"
        )));
        assert!(event_is_unsafe_to_send(&event_with_logentry("password=hunter2")));
    }

    #[test]
    fn an_ordinary_logentry_is_sent() {
        assert!(!event_is_unsafe_to_send(&event_with_logentry(
            "R2 PUT docs/ws-1/docs/doc-1.json -> 403 Forbidden"
        )));
    }

    #[test]
    fn scrub_event_drops_unsafe_and_passes_the_rest() {
        // The exact function wired into `before_send`, so the hook cannot
        // silently diverge from what these tests cover.
        assert!(scrub_event(event_with_logentry("Bearer abc")).is_none());
        assert!(scrub_event(event_with_message("secret=x")).is_none());
        assert!(scrub_event(event_with_logentry("blob s3 put failed ws-1/abc")).is_some());
    }

    #[test]
    fn the_marker_match_is_case_insensitive() {
        assert!(event_is_unsafe_to_send(&event_with_message("AUTHORIZATION: Bearer x")));
        assert!(event_is_unsafe_to_send(&event_with_message("Set-Cookie: a=b")));
    }

    #[test]
    fn release_ties_an_event_to_an_exact_binary() {
        let r = release_name();
        assert!(r.starts_with(build_info::VERSION));
        assert!(r.contains(build_info::GIT_SHA));
    }

    #[test]
    fn environment_never_guesses_production() {
        // With neither var set the answer is `unknown` — mislabelling a staging
        // event as production would be worse than leaving it unlabelled.
        temp_env_absent(&["SENTRY_ENVIRONMENT", "RELAY_REGION"], || {
            assert_eq!(environment_name(), "unknown");
        });
    }

    /// Run `f` with the named vars removed, restoring them afterwards.
    fn temp_env_absent(keys: &[&str], f: impl FnOnce()) {
        let saved: Vec<(String, Option<String>)> = keys
            .iter()
            .map(|k| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for k in keys {
            std::env::remove_var(k);
        }
        f();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
    }
}


// ---------------------------------------------------------------------------
// Durability reporting
// ---------------------------------------------------------------------------

/// How long to stay quiet before re-announcing an ongoing durability outage.
const DURABILITY_REANNOUNCE_AFTER: Duration = Duration::from_secs(300);

/// Tracks the health of durable (R2) writes and decides how loudly to report.
///
/// ## Why this is not just `log::error!` at the call site
///
/// Every durable write failed for an unknown period in both environments and
/// nobody noticed, because each failure was a `warn!` in an ephemeral log
/// (JP-505). The obvious fix — promote them to `error!` so they become Sentry
/// events — floods: these run in background queue workers, so when R2 is
/// unavailable *every* op fails. Fifty active documents on a ten-second
/// snapshot interval is roughly eighteen thousand events an hour, which is not
/// an alert, it is a denial of service against your own issue stream.
///
/// So report on **transitions and intervals**, not occurrences: the first
/// failure after health is an event, further failures are counted quietly, and
/// an ongoing outage re-announces every five minutes carrying the running
/// count. Recovery logs once at info. One outage becomes a handful of events
/// that each say how bad it is, and per-op detail stays in the log where the
/// call sites already put it.
pub struct DurabilityMonitor {
    state: Mutex<DurabilityState>,
    reannounce_after: Duration,
}

#[derive(Default)]
struct DurabilityState {
    consecutive_failures: u64,
    /// When the current outage was last announced. `None` = currently healthy.
    announced_at: Option<Instant>,
}

/// What the monitor decided to do about one outcome — returned so the decision
/// is testable without capturing log output.
#[derive(Debug, PartialEq, Eq)]
pub enum DurabilityReport {
    /// Nothing to say (a success while healthy, or a failure already announced).
    Quiet,
    /// Durable writes have started failing. Carries the running failure count.
    OutageStarted(u64),
    /// Still failing, and the quiet window has elapsed. Carries the count.
    OutageContinuing(u64),
    /// A write succeeded after an announced outage. Carries the failure count
    /// that outage reached.
    Recovered(u64),
}

impl DurabilityMonitor {
    pub fn new(reannounce_after: Duration) -> Self {
        Self {
            state: Mutex::new(DurabilityState::default()),
            reannounce_after,
        }
    }

    /// A lock is only ever held for a few field updates, so poisoning cannot
    /// leave it inconsistent — recover the guard rather than panicking inside
    /// a storage path.
    fn lock(&self) -> std::sync::MutexGuard<'_, DurabilityState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record a failed durable write. `now` is injected so the interval
    /// behaviour is testable without sleeping.
    pub fn record_failure_at(&self, now: Instant) -> DurabilityReport {
        let mut st = self.lock();
        st.consecutive_failures += 1;
        let count = st.consecutive_failures;
        match st.announced_at {
            None => {
                st.announced_at = Some(now);
                DurabilityReport::OutageStarted(count)
            }
            Some(at) if now.duration_since(at) >= self.reannounce_after => {
                st.announced_at = Some(now);
                DurabilityReport::OutageContinuing(count)
            }
            Some(_) => DurabilityReport::Quiet,
        }
    }

    /// Record a successful durable write.
    pub fn record_success(&self) -> DurabilityReport {
        let mut st = self.lock();
        let count = st.consecutive_failures;
        let was_announced = st.announced_at.is_some();
        st.consecutive_failures = 0;
        st.announced_at = None;
        if was_announced {
            DurabilityReport::Recovered(count)
        } else {
            DurabilityReport::Quiet
        }
    }

    /// Record a failure and log it at the level the decision calls for.
    /// `target` is the object key; `err` the backend's own message.
    pub fn on_failure(&self, target: &str, err: &str) {
        match self.record_failure_at(Instant::now()) {
            DurabilityReport::OutageStarted(n) => log::error!(
                "durable writes are FAILING ({n} consecutive) — most recent: {target}: {err}"
            ),
            DurabilityReport::OutageContinuing(n) => log::error!(
                "durable writes still failing ({n} consecutive) — most recent: {target}: {err}"
            ),
            // The call site already logs this one at warn with full detail;
            // saying it twice would only make the log harder to read.
            _ => {}
        }
    }

    /// Record a success and log a recovery notice if one is due.
    pub fn on_success(&self) {
        if let DurabilityReport::Recovered(n) = self.record_success() {
            log::info!("durable writes recovered after {n} consecutive failures");
        }
    }
}

/// Process-wide durability monitor. One instance because the question it
/// answers — "are durable writes working?" — is a property of the process, not
/// of any one workspace or document.
pub fn durability() -> &'static DurabilityMonitor {
    static MONITOR: LazyLock<DurabilityMonitor> =
        LazyLock::new(|| DurabilityMonitor::new(DURABILITY_REANNOUNCE_AFTER));
    &MONITOR
}

#[cfg(test)]
mod durability_tests {
    use super::*;

    fn monitor() -> DurabilityMonitor {
        DurabilityMonitor::new(Duration::from_secs(300))
    }

    #[test]
    fn the_first_failure_is_announced() {
        let m = monitor();
        assert_eq!(m.record_failure_at(Instant::now()), DurabilityReport::OutageStarted(1));
    }

    #[test]
    fn further_failures_inside_the_window_stay_quiet() {
        // The whole point: an outage must not emit one event per failed write.
        let m = monitor();
        let t0 = Instant::now();
        m.record_failure_at(t0);
        for i in 1..500 {
            assert_eq!(
                m.record_failure_at(t0 + Duration::from_secs(i % 60)),
                DurabilityReport::Quiet
            );
        }
    }

    #[test]
    fn an_ongoing_outage_re_announces_after_the_window_with_a_running_count() {
        let m = monitor();
        let t0 = Instant::now();
        m.record_failure_at(t0);
        m.record_failure_at(t0 + Duration::from_secs(10));
        assert_eq!(
            m.record_failure_at(t0 + Duration::from_secs(300)),
            DurabilityReport::OutageContinuing(3)
        );
    }

    #[test]
    fn success_while_healthy_says_nothing() {
        let m = monitor();
        assert_eq!(m.record_success(), DurabilityReport::Quiet);
    }

    #[test]
    fn recovery_reports_how_bad_the_outage_got() {
        let m = monitor();
        let t0 = Instant::now();
        for i in 0..4 {
            m.record_failure_at(t0 + Duration::from_secs(i));
        }
        assert_eq!(m.record_success(), DurabilityReport::Recovered(4));
    }

    #[test]
    fn a_new_outage_after_recovery_is_announced_again() {
        // Without the reset on success, a second outage would be silent — the
        // failure mode that would make this whole mechanism worse than useless.
        let m = monitor();
        let t0 = Instant::now();
        m.record_failure_at(t0);
        m.record_success();
        assert_eq!(
            m.record_failure_at(t0 + Duration::from_secs(1)),
            DurabilityReport::OutageStarted(1)
        );
    }

    #[test]
    fn the_failure_count_resets_on_recovery() {
        let m = monitor();
        let t0 = Instant::now();
        m.record_failure_at(t0);
        m.record_failure_at(t0);
        m.record_success();
        m.record_failure_at(t0 + Duration::from_secs(1));
        assert_eq!(m.record_success(), DurabilityReport::Recovered(1));
    }
}
