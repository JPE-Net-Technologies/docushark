//! AU-2 (JP-300): resource-bound audience validation (RFC 8707).
//!
//! The control plane mints `aud = [resource, "docushark-relay"]` where the
//! resource is the pod's `{origin}/mcp` (the value RFC 9728 discovery already
//! advertises). A relay configured with that resource accepts the token; a
//! legacy `audience`-only relay still accepts it via the shared legacy value
//! (non-breaking rollout); and a relay for a *different* pod rejects a token
//! that doesn't carry its resource — the per-pod isolation the design provides
//! once the legacy audience is eventually dropped.

use docushark_relay::auth::AuthError;
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::json;

const POD_A: &str = "https://pod-a.example/mcp";
const POD_B: &str = "https://pod-b.example/mcp";
const LEGACY_AUD: &str = "docushark-relay";

#[tokio::test]
async fn array_aud_is_accepted_by_resource_pod_and_legacy_pod() {
    let issuer = OidcTestIssuer::new().await;
    // Production shape: aud carries the pod resource AND the legacy audience.
    let token = issuer.mint_with_aud(json!([POD_A, LEGACY_AUD]));

    // Pod A (configured with its resource) accepts via the resource match.
    assert!(issuer.validate(&token, Some(POD_A)).await.is_ok());

    // A relay with no resource configured still accepts via the legacy audience
    // — this is what makes the rollout non-breaking regardless of deploy order.
    assert!(issuer.validate(&token, None).await.is_ok());
}

#[tokio::test]
async fn resource_only_token_is_isolated_to_its_pod() {
    let issuer = OidcTestIssuer::new().await;
    // A token bound to ONLY pod B's resource (no legacy aud) — the post-rollout
    // shape once the legacy audience is dropped.
    let token = issuer.mint_with_aud(json!(POD_B));

    // Pod B accepts it.
    assert!(issuer.validate(&token, Some(POD_B)).await.is_ok());

    // Pod A rejects it: its accepted set is {legacy, POD_A}, and the token's aud
    // (POD_B) intersects neither.
    let err = issuer.validate(&token, Some(POD_A)).await.unwrap_err();
    assert!(matches!(err, AuthError::AudienceMismatch), "got {err:?}");
}
