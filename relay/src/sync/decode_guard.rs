//! Panic containment for `yrs` decoders fed untrusted bytes (JP-476).
//!
//! `yrs` treats the client-id width as an internal invariant rather than an
//! input check. `StateVector::decode` (and the update decoder) feed the varint
//! they just read straight into `ClientID::new`, which asserts the value fits
//! the 53-bit JS-safe space:
//!
//! ```text
//! yrs-0.27.3/src/block.rs:92:  debug_assert!(value & Self::MASK == 0);
//! ```
//!
//! A remote peer only has to send a client id >= 2^53 to trip it — roughly ten
//! bytes of well-shaped garbage. `Decode` *is* the untrusted-input boundary and
//! already returns `Result`, so the correct upstream behaviour is `Err`, not an
//! assert. Until that lands we contain it here rather than hand-rolling a
//! second lib0 varint reader to pre-validate: a parallel decoder that can
//! disagree with the real one is a worse bug than the one being fixed.
//!
//! **Debug vs release.** `debug_assert!` is compiled out of release builds, so
//! release does not panic — it silently accepts the truncated id
//! (`ClientID::get` masks the high bits straight back off), which is an
//! identity collision in the CRDT rather than a crash. This guard therefore
//! fixes the crash class only; the truncation is an upstream correctness bug
//! and is reported as such.

use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::server::panic_message;

/// Run an untrusted `yrs` decode, converting an upstream **panic** into an
/// ordinary `Err`.
///
/// Sound by construction: the closures below decode a `&[u8]` into an owned
/// value, or build and populate a throwaway `Doc` that the caller drops on
/// error. Neither touches shared state, so unwinding out of one cannot leave a
/// live document half-mutated — `AssertUnwindSafe` here is a real guarantee,
/// not a suppression.
///
/// Deliberately *not* applied to `apply_update` against the live authoritative
/// `Doc`: that call mutates shared state, so catching an unwind mid-apply would
/// trade a loud crash for a silently inconsistent document. A panic there must
/// stay fatal to the connection.
pub fn guard_decode<T, E: std::fmt::Display>(
    what: &str,
    decode: impl FnOnce() -> Result<T, E>,
) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(decode)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(e.to_string()),
        Err(payload) => {
            let msg = panic_message(&payload);
            // Malformed input is a client-side fault, not a relay fault — warn
            // (not error) so a peer spraying garbage cannot mimic a real
            // server incident in the logs.
            log::warn!("{what}: yrs decoder panicked on malformed input: {msg}");
            Err(format!("decoder panicked on malformed input: {msg}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_ok_and_err() {
        let ok = guard_decode("t", || Ok::<_, String>(7u8));
        assert_eq!(ok, Ok(7));

        let err = guard_decode("t", || Err::<u8, _>("bad varint"));
        assert_eq!(err, Err("bad varint".to_string()));
    }

    #[test]
    fn converts_panic_into_err() {
        let err = guard_decode("t", || -> Result<u8, String> { panic!("boom") })
            .expect_err("panic must surface as Err");
        assert!(err.contains("boom"), "message should carry the panic text: {err}");
    }
}
