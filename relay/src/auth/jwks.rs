//! JWKS fetch + cache for the OIDC validation path (JP-77).
//!
//! Behaviour matches `relay/docs/api/token-format.md`:
//! - In-memory cache, 5-minute refresh interval.
//! - Background refresh task; misses do not block request validation.
//! - Fail-open with the last-known-good keyset for a 1-hour grace
//!   window if the JWKS endpoint is unreachable. Past the grace,
//!   `get_for_validation` returns `JwksUnavailable` and validation
//!   fails closed.
//! - Unknown-`kid` lookups trigger a debounced one-shot refresh so a
//!   freshly-rotated key is picked up without waiting for the next
//!   periodic tick.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::DecodingKey;
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use super::AuthError;

/// Refresh cadence for the background task.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(300);
/// Fail-open grace after the last successful fetch.
pub const FAIL_OPEN_GRACE: Duration = Duration::from_secs(3600);
/// Floor between debounced on-demand refreshes (unknown-kid path).
const ON_DEMAND_DEBOUNCE: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct Jwk {
    kty: String,
    #[serde(default)]
    alg: Option<String>,
    kid: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

struct CacheInner {
    /// Map of `kid` → decoded RSA public key.
    keys: HashMap<String, DecodingKey>,
    /// When the last successful fetch landed. `None` until the first
    /// refresh succeeds.
    last_success: Option<Instant>,
}

impl CacheInner {
    fn empty() -> Self {
        Self { keys: HashMap::new(), last_success: None }
    }
}

/// Snapshotted observability data — used by `/metrics`.
#[derive(Debug, Clone, Default)]
pub struct JwksMetrics {
    pub cache_age_seconds: Option<u64>,
    pub refresh_failures_total: u64,
    pub key_count: usize,
}

#[derive(Clone)]
pub struct JwksCache {
    inner: Arc<RwLock<CacheInner>>,
    refresh_lock: Arc<Mutex<Instant>>, // value = last on-demand attempt
    failures: Arc<std::sync::atomic::AtomicU64>,
    jwks_url: Arc<String>,
    http: reqwest::Client,
}

impl JwksCache {
    /// Build a cache pointed at `jwks_url`. Does **not** fetch
    /// synchronously — call [`start_background_refresh`] to install
    /// the periodic task, or [`refresh_once`] for tests.
    pub fn new(jwks_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self {
            inner: Arc::new(RwLock::new(CacheInner::empty())),
            refresh_lock: Arc::new(Mutex::new(Instant::now() - ON_DEMAND_DEBOUNCE * 2)),
            failures: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            jwks_url: Arc::new(jwks_url),
            http,
        }
    }

    /// Spawn the background refresh task. Caller owns the returned
    /// [`tokio::task::JoinHandle`] (drop it on shutdown).
    pub fn start_background_refresh(&self) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            // Eagerly attempt one fetch on boot so the first request
            // doesn't have to pay the cold-cache latency.
            let _ = me.refresh_once().await;
            let mut ticker = tokio::time::interval(REFRESH_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // First tick fires immediately; absorb it.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let _ = me.refresh_once().await;
            }
        })
    }

    /// Resolve a `kid` for the validation path. Returns `Ok(Some(key))`
    /// when the cache holds the key, `Ok(None)` when the key is
    /// unknown but the cache is still within the fail-open grace
    /// (caller may attempt a one-shot refresh), or
    /// `Err(JwksUnavailable)` when the cache is empty and the grace
    /// has expired.
    pub async fn get(&self, kid: &str) -> Result<Option<DecodingKey>, AuthError> {
        let guard = self.inner.read().await;
        if let Some(key) = guard.keys.get(kid) {
            return Ok(Some(key.clone()));
        }
        match guard.last_success {
            Some(ts) if ts.elapsed() <= FAIL_OPEN_GRACE => Ok(None),
            Some(_) => Err(AuthError::JwksUnavailable),
            None => Err(AuthError::JwksUnavailable),
        }
    }

    /// Force a single refresh attempt, debounced so an unknown-kid
    /// flood can't DOS the JWKS endpoint. Safe to call from the
    /// validation hot path.
    pub async fn refresh_on_miss(&self) {
        let mut last = self.refresh_lock.lock().await;
        if last.elapsed() < ON_DEMAND_DEBOUNCE {
            return;
        }
        *last = Instant::now();
        drop(last);
        let _ = self.refresh_once().await;
    }

    /// Fetch + parse + swap the cache. Returns `Ok(())` on a refresh
    /// that produced at least one usable key, `Err(())` otherwise.
    /// Failures bump the metric counter; the existing cache is
    /// preserved.
    pub async fn refresh_once(&self) -> Result<(), ()> {
        let response = match self.http.get(self.jwks_url.as_str()).send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("jwks fetch failed: {}", e);
                self.failures
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Err(());
            }
        };
        if !response.status().is_success() {
            log::warn!("jwks fetch returned HTTP {}", response.status());
            self.failures
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Err(());
        }
        let body: JwkSet = match response.json().await {
            Ok(b) => b,
            Err(e) => {
                log::warn!("jwks parse failed: {}", e);
                self.failures
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Err(());
            }
        };

        let mut decoded: HashMap<String, DecodingKey> = HashMap::new();
        for jwk in body.keys {
            let kid = match jwk.kid.as_deref() {
                Some(k) if !k.is_empty() => k.to_string(),
                _ => {
                    log::warn!("jwks: skipping key without kid");
                    continue;
                }
            };
            if jwk.kty != "RSA" {
                log::warn!("jwks: skipping kid={} kty={} (only RSA accepted)", kid, jwk.kty);
                continue;
            }
            if matches!(jwk.alg.as_deref(), Some(alg) if alg != "RS256") {
                log::warn!("jwks: skipping kid={} alg={:?} (only RS256 accepted)", kid, jwk.alg);
                continue;
            }
            let Some(n) = jwk.n.as_deref() else {
                log::warn!("jwks: skipping kid={} (missing modulus)", kid);
                continue;
            };
            let Some(e) = jwk.e.as_deref() else {
                log::warn!("jwks: skipping kid={} (missing exponent)", kid);
                continue;
            };
            match DecodingKey::from_rsa_components(n, e) {
                Ok(key) => {
                    decoded.insert(kid, key);
                }
                Err(err) => {
                    log::warn!("jwks: kid={} rejected: {}", kid, err);
                }
            }
        }

        if decoded.is_empty() {
            log::warn!("jwks fetch produced no usable keys; keeping previous cache");
            self.failures
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Err(());
        }

        let mut guard = self.inner.write().await;
        guard.keys = decoded;
        guard.last_success = Some(Instant::now());
        Ok(())
    }

    /// Snapshot for the metrics endpoint.
    pub async fn metrics(&self) -> JwksMetrics {
        let guard = self.inner.read().await;
        JwksMetrics {
            cache_age_seconds: guard.last_success.map(|t| t.elapsed().as_secs()),
            refresh_failures_total: self.failures.load(std::sync::atomic::Ordering::Relaxed),
            key_count: guard.keys.len(),
        }
    }

    /// Test helper: inject a key directly without going through HTTP.
    #[cfg(feature = "test-helpers")]
    pub async fn insert_for_tests(&self, kid: &str, key: DecodingKey) {
        let mut guard = self.inner.write().await;
        guard.keys.insert(kid.to_string(), key);
        guard.last_success = Some(Instant::now());
    }
}
