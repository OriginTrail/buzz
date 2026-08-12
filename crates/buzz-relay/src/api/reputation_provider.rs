//! Backend-neutral reputation-provider boundary.
//!
//! The first configured provider is the existing OriginTrail DKG query
//! gateway.  The null provider is the default and reports `disabled` instead
//! of manufacturing an empty evidence set.  Provider metadata is added to the
//! existing gateway envelope without changing its `result`, so current DKG
//! clients remain compatible while reputation callers gain explicit
//! resolution semantics.

use async_trait::async_trait;
use axum::{http::StatusCode, response::Json};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::DkgQueryConfig;

use super::{api_error, dkg_query};

type ApiResponse = (StatusCode, Json<Value>);
type ApiResult = Result<ApiResponse, ApiResponse>;

/// Outcome of one bounded reputation-provider resolution attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionState {
    /// No provider is configured. This is not an empty evidence result.
    Disabled,
    /// Every configured source answered within the bounded request.
    Complete,
    /// At least one configured source could not provide a complete page.
    Partial,
    /// The provider could not perform the resolution attempt.
    Unavailable,
}

/// Per-source status carried with every provider result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDiagnostic {
    /// Stable identifier for the contributing source.
    pub source_id: &'static str,
    /// Resolution reached by this source.
    pub resolution: ResolutionState,
    /// Safe, human-readable reason for a non-complete result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Backend-neutral result returned by [`ReputationProvider`].
#[derive(Debug)]
pub struct ReputationBatch {
    /// Aggregate resolution for this request.
    pub resolution: ResolutionState,
    /// Stable provider identifier.
    pub provider_id: &'static str,
    /// Provider contract version.
    pub provider_version: &'static str,
    /// Time at which the resolution was produced.
    pub as_of: DateTime<Utc>,
    /// Per-source outcomes used to produce the aggregate resolution.
    pub source_diagnostics: Vec<SourceDiagnostic>,
    response: Option<ApiResponse>,
}

impl ReputationBatch {
    fn disabled() -> Self {
        Self {
            resolution: ResolutionState::Disabled,
            provider_id: "null",
            provider_version: "1",
            as_of: Utc::now(),
            source_diagnostics: Vec::new(),
            response: None,
        }
    }

    fn dkg(resolution: ResolutionState, response: ApiResponse, detail: Option<String>) -> Self {
        Self {
            resolution,
            provider_id: "origintrail-dkg",
            provider_version: "dkg-trust@1",
            as_of: Utc::now(),
            source_diagnostics: vec![SourceDiagnostic {
                source_id: "origintrail-dkg",
                resolution,
                detail,
            }],
            response: Some(response),
        }
    }

    fn metadata(&self) -> Map<String, Value> {
        let mut metadata = Map::new();
        metadata.insert(
            "resolution".to_string(),
            serde_json::to_value(self.resolution).expect("resolution serializes"),
        );
        metadata.insert(
            "providerId".to_string(),
            Value::String(self.provider_id.to_string()),
        );
        metadata.insert(
            "providerVersion".to_string(),
            Value::String(self.provider_version.to_string()),
        );
        metadata.insert("asOf".to_string(), Value::String(self.as_of.to_rfc3339()));
        metadata.insert(
            "sourceDiagnostics".to_string(),
            serde_json::to_value(&self.source_diagnostics).expect("diagnostics serialize"),
        );
        metadata
    }

    /// Convert the provider result back to the relay's existing HTTP shape.
    ///
    /// Successful DKG responses retain `ok`, `channelId`, `cg`, `operation`,
    /// and `result`. The provider fields are additive. Disabled and unavailable
    /// providers use the same fields on an error response, allowing a new
    /// client to distinguish configuration from outage without changing the
    /// legacy route-discovery behavior.
    pub fn into_http_result(mut self) -> ApiResult {
        let response = self.response.take();
        let metadata = self.metadata();
        let (status, Json(mut value)) = response.unwrap_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "reputation provider is not configured",
            )
        });
        let Some(object) = value.as_object_mut() else {
            let (status, Json(mut error)) = api_error(
                StatusCode::BAD_GATEWAY,
                "reputation provider returned an invalid response envelope",
            );
            error
                .as_object_mut()
                .expect("api errors are objects")
                .extend(metadata);
            return Err((status, Json(error)));
        };
        object.extend(metadata);

        let response = (status, Json(value));
        if status.is_success() && self.resolution != ResolutionState::Unavailable {
            Ok(response)
        } else {
            Err(response)
        }
    }
}

/// Minimal provider seam for evidence-backed reputation resolution.
#[async_trait]
pub trait ReputationProvider: Send + Sync {
    /// Resolve the bounded attestation request without changing its scope.
    async fn attestations(&self, request: &Value) -> ReputationBatch;
}

/// Default provider: reputation is disabled, not empty.
#[derive(Debug, Default)]
pub struct NullProvider;

#[async_trait]
impl ReputationProvider for NullProvider {
    async fn attestations(&self, _request: &Value) -> ReputationBatch {
        ReputationBatch::disabled()
    }
}

/// Adapter for the existing bounded OriginTrail DKG trust operations.
#[derive(Debug)]
pub struct DkgProvider<'a> {
    config: &'a DkgQueryConfig,
}

impl<'a> DkgProvider<'a> {
    fn new(config: &'a DkgQueryConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl ReputationProvider for DkgProvider<'_> {
    async fn attestations(&self, request: &Value) -> ReputationBatch {
        let client = match dkg_query::HTTP_CLIENT.as_ref() {
            Ok(client) => client,
            Err(_) => {
                return ReputationBatch::dkg(
                    ResolutionState::Unavailable,
                    api_error(
                        StatusCode::BAD_GATEWAY,
                        "reputation provider is unavailable",
                    ),
                    Some("HTTP client initialization failed".to_string()),
                );
            }
        };
        let response = match client
            .post(self.config.url.clone())
            .bearer_auth(&self.config.bearer_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(self.config.timeout)
            .json(request)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let detail = if error.is_timeout() {
                    "provider deadline exceeded"
                } else {
                    "provider transport failed"
                };
                return ReputationBatch::dkg(
                    ResolutionState::Unavailable,
                    dkg_query::upstream_error(error),
                    Some(detail.to_string()),
                );
            }
        };

        match dkg_query::bounded_json_response(response).await {
            Ok((status, Json(value))) if status.is_success() => {
                let resolution = resolution_from_gateway(&value);
                ReputationBatch::dkg(resolution, (status, Json(value)), None)
            }
            Ok(response) => ReputationBatch::dkg(
                ResolutionState::Unavailable,
                response,
                Some("provider rejected the bounded request".to_string()),
            ),
            Err(response) => ReputationBatch::dkg(
                ResolutionState::Unavailable,
                response,
                Some("provider returned an unusable response".to_string()),
            ),
        }
    }
}

/// Runtime provider selection. The null provider is the deterministic default.
#[derive(Debug)]
pub enum ConfiguredReputationProvider<'a> {
    /// Deterministic default when reputation is not configured.
    Null(NullProvider),
    /// Existing OriginTrail DKG trust-query adapter.
    Dkg(DkgProvider<'a>),
}

impl<'a> ConfiguredReputationProvider<'a> {
    /// Select the configured DKG adapter or the null provider.
    pub fn from_dkg_config(config: Option<&'a DkgQueryConfig>) -> Self {
        match config.filter(|config| config.trust_enabled) {
            Some(config) => Self::Dkg(DkgProvider::new(config)),
            None => Self::Null(NullProvider),
        }
    }
}

#[async_trait]
impl ReputationProvider for ConfiguredReputationProvider<'_> {
    async fn attestations(&self, request: &Value) -> ReputationBatch {
        match self {
            Self::Null(provider) => provider.attestations(request).await,
            Self::Dkg(provider) => provider.attestations(request).await,
        }
    }
}

fn resolution_from_gateway(value: &Value) -> ResolutionState {
    match value
        .pointer("/result/completeness")
        .and_then(Value::as_str)
    {
        Some("partial") => ResolutionState::Partial,
        _ => ResolutionState::Complete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn null_provider_is_disabled_not_empty_complete() {
        let provider = ConfiguredReputationProvider::from_dkg_config(None);
        let batch = provider.attestations(&serde_json::json!({})).await;
        assert_eq!(batch.resolution, ResolutionState::Disabled);
        assert_eq!(batch.provider_id, "null");
        assert!(batch.source_diagnostics.is_empty());

        let error = batch
            .into_http_result()
            .expect_err("disabled provider is not an evidence response");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        assert_eq!(error.1 .0["resolution"], "disabled");
        assert_eq!(error.1 .0["providerId"], "null");
    }

    #[test]
    fn gateway_completeness_maps_to_explicit_resolution_states() {
        assert_eq!(
            resolution_from_gateway(&serde_json::json!({
                "result": {"completeness": "complete"}
            })),
            ResolutionState::Complete
        );
        assert_eq!(
            resolution_from_gateway(&serde_json::json!({
                "result": {"completeness": "partial"}
            })),
            ResolutionState::Partial
        );
    }

    #[test]
    fn provider_metadata_is_additive_to_the_existing_gateway_envelope() {
        let batch = ReputationBatch::dkg(
            ResolutionState::Complete,
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "channelId": "channel",
                    "cg": "cg",
                    "operation": "trust_network",
                    "result": {"completeness": "complete", "people": [], "vouches": []}
                })),
            ),
            None,
        );
        let (_, Json(value)) = batch.into_http_result().expect("successful batch");
        assert_eq!(value["result"]["people"], serde_json::json!([]));
        assert_eq!(value["resolution"], "complete");
        assert_eq!(value["providerId"], "origintrail-dkg");
        assert_eq!(value["providerVersion"], "dkg-trust@1");
        assert!(value["asOf"].is_string());
    }
}
