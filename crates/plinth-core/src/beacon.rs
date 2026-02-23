use serde::{Deserialize, Serialize};

use crate::metrics::Metrics;
use crate::state::PlayerState;

/// Beacon event type — drives which additional fields are present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeaconEvent {
    SessionOpen,
    FirstFrame,
    Pause,
    Play,
    SeekStart,
    SeekEnd,
    RebufferStart,
    RebufferEnd,
    QualityChange,
    Error,
    Heartbeat,
    SessionEnd,
}

/// A single beacon. Flat struct with `skip_serializing_if` on optional fields
/// so the JSON matches the schema's conditional-field rules without a wrapper enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Beacon {
    pub seq: u32,
    pub play_id: String,
    pub ts: u64,
    pub event: BeaconEvent,

    // Present on all beacons except session_open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<PlayerState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,

    // session_open fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdk: Option<SdkMetadata>,

    // heartbeat field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playhead_ms: Option<u64>,

    // seek fields (present on seek_start and seek_end).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seek_from_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seek_to_ms: Option<u64>,

    // quality_change field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<QualityLevel>,

    // error field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PlayerError>,
}

/// HTTP POST body — wraps a batch of beacons from a single play session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeaconBatch {
    pub beacons: Vec<Beacon>,
}

impl BeaconBatch {
    pub fn new(beacons: Vec<Beacon>) -> Self {
        BeaconBatch { beacons }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

// ── Metadata types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientMetadata {
    pub user_agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkMetadata {
    pub api_version: u32,
    pub core: SdkComponent,
    pub framework: SdkComponent,
    pub player: SdkComponent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkComponent {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityLevel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_bps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framerate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerError {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub fatal: bool,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── BeaconEvent serialization ────────────────────────────────────────────

    #[test]
    fn beacon_event_serializes_to_snake_case() {
        let cases = [
            (BeaconEvent::SessionOpen, "\"session_open\""),
            (BeaconEvent::FirstFrame, "\"first_frame\""),
            (BeaconEvent::Pause, "\"pause\""),
            (BeaconEvent::Play, "\"play\""),
            (BeaconEvent::SeekStart, "\"seek_start\""),
            (BeaconEvent::SeekEnd, "\"seek_end\""),
            (BeaconEvent::RebufferStart, "\"rebuffer_start\""),
            (BeaconEvent::RebufferEnd, "\"rebuffer_end\""),
            (BeaconEvent::QualityChange, "\"quality_change\""),
            (BeaconEvent::Error, "\"error\""),
            (BeaconEvent::Heartbeat, "\"heartbeat\""),
            (BeaconEvent::SessionEnd, "\"session_end\""),
        ];
        for (event, expected) in cases {
            assert_eq!(
                serde_json::to_string(&event).unwrap(),
                expected,
                "BeaconEvent::{:?}",
                event
            );
        }
    }

    #[test]
    fn beacon_event_deserializes_from_snake_case() {
        let e: BeaconEvent = serde_json::from_str("\"rebuffer_start\"").unwrap();
        assert_eq!(e, BeaconEvent::RebufferStart);
        let e: BeaconEvent = serde_json::from_str("\"session_open\"").unwrap();
        assert_eq!(e, BeaconEvent::SessionOpen);
    }

    // ── PlayerState serialization ────────────────────────────────────────────

    #[test]
    fn player_state_serializes_to_snake_case() {
        let cases = [
            (PlayerState::Idle, "\"idle\""),
            (PlayerState::Loading, "\"loading\""),
            (PlayerState::Ready, "\"ready\""),
            (PlayerState::PlayAttempt, "\"play_attempt\""),
            (PlayerState::Buffering, "\"buffering\""),
            (PlayerState::Playing, "\"playing\""),
            (PlayerState::Paused, "\"paused\""),
            (PlayerState::Seeking, "\"seeking\""),
            (PlayerState::Rebuffering, "\"rebuffering\""),
            (PlayerState::Ended, "\"ended\""),
            (PlayerState::Error, "\"error\""),
        ];
        for (state, expected) in cases {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                expected,
                "PlayerState::{:?}",
                state
            );
        }
    }

    #[test]
    fn player_state_roundtrips_through_json() {
        for state in [
            PlayerState::Idle,
            PlayerState::PlayAttempt,
            PlayerState::Rebuffering,
            PlayerState::Ended,
        ] {
            let json = serde_json::to_string(&state).unwrap();
            let back: PlayerState = serde_json::from_str(&json).unwrap();
            assert_eq!(back, state);
        }
    }

    // ── Beacon field omission ────────────────────────────────────────────────

    fn minimal_beacon(event: BeaconEvent) -> Beacon {
        Beacon {
            seq: 0,
            play_id: "00000000-0000-0000-0000-000000000000".to_string(),
            ts: 1000,
            event,
            state: None,
            metrics: None,
            video: None,
            client: None,
            sdk: None,
            playhead_ms: None,
            seek_from_ms: None,
            seek_to_ms: None,
            quality: None,
            error: None,
        }
    }

    #[test]
    fn beacon_omits_all_none_fields() {
        let b = minimal_beacon(BeaconEvent::Pause);
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"seq\":0"));
        assert!(json.contains("\"event\":\"pause\""));
        // None fields must not appear in output.
        for key in &["state", "metrics", "video", "client", "sdk",
                     "playhead_ms", "seek_from_ms", "seek_to_ms", "quality", "\"error\""] {
            assert!(!json.contains(key), "key {:?} should be absent", key);
        }
    }

    #[test]
    fn beacon_includes_present_optional_fields() {
        let mut b = minimal_beacon(BeaconEvent::Heartbeat);
        b.state = Some(PlayerState::Playing);
        b.playhead_ms = Some(42_000);
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"state\":\"playing\""));
        assert!(json.contains("\"playhead_ms\":42000"));
        assert!(!json.contains("seek_from_ms"));
    }

    #[test]
    fn beacon_seek_fields_serialized() {
        let mut b = minimal_beacon(BeaconEvent::SeekEnd);
        b.seek_from_ms = Some(10_000);
        b.seek_to_ms = Some(60_000);
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"seek_from_ms\":10000"));
        assert!(json.contains("\"seek_to_ms\":60000"));
        assert!(!json.contains("playhead_ms"));
    }

    // ── BeaconBatch ──────────────────────────────────────────────────────────

    #[test]
    fn beacon_batch_wraps_beacons_under_key() {
        let b = minimal_beacon(BeaconEvent::SessionOpen);
        let batch = BeaconBatch::new(vec![b]);
        let json = batch.to_json().unwrap();
        assert!(json.starts_with("{\"beacons\":["), "got: {}", json);
        assert!(json.ends_with("]}"), "got: {}", json);
    }

    #[test]
    fn beacon_batch_preserves_beacon_count() {
        let beacons = vec![
            minimal_beacon(BeaconEvent::SessionOpen),
            minimal_beacon(BeaconEvent::FirstFrame),
        ];
        let batch = BeaconBatch::new(beacons);
        let parsed: serde_json::Value = serde_json::from_str(&batch.to_json().unwrap()).unwrap();
        assert_eq!(parsed["beacons"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn beacon_batch_roundtrips_through_json() {
        let mut b = minimal_beacon(BeaconEvent::Heartbeat);
        b.state = Some(PlayerState::Playing);
        b.playhead_ms = Some(5000);
        b.metrics = Some(Metrics {
            vst_ms: Some(1000),
            played_ms: 4000,
            rebuffer_ms: 0,
            watched_ms: 5000,
            rebuffer_count: 0,
            error_count: 0,
        });
        let batch = BeaconBatch::new(vec![b.clone()]);
        let json = batch.to_json().unwrap();
        let back: BeaconBatch = serde_json::from_str(&json).unwrap();
        let rb = &back.beacons[0];
        assert_eq!(rb.event, BeaconEvent::Heartbeat);
        assert_eq!(rb.state, Some(PlayerState::Playing));
        assert_eq!(rb.playhead_ms, Some(5000));
        let m = rb.metrics.as_ref().unwrap();
        assert_eq!(m.vst_ms, Some(1000));
        assert_eq!(m.played_ms, 4000);
    }

    // ── Metadata types ───────────────────────────────────────────────────────

    #[test]
    fn video_metadata_omits_title_when_none() {
        let v = VideoMetadata { id: "vid-1".to_string(), title: None };
        assert_eq!(serde_json::to_string(&v).unwrap(), "{\"id\":\"vid-1\"}");
    }

    #[test]
    fn video_metadata_includes_title_when_present() {
        let v = VideoMetadata { id: "vid-1".to_string(), title: Some("My Video".to_string()) };
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"title\":\"My Video\""));
    }

    #[test]
    fn quality_level_omits_none_fields() {
        let q = QualityLevel {
            bitrate_bps: Some(2_500_000),
            width: None,
            height: None,
            framerate: None,
            codec: Some("avc1.4d401f".to_string()),
        };
        let json = serde_json::to_string(&q).unwrap();
        assert!(json.contains("\"bitrate_bps\":2500000"));
        assert!(json.contains("\"codec\":\"avc1.4d401f\""));
        assert!(!json.contains("width"));
        assert!(!json.contains("height"));
        assert!(!json.contains("framerate"));
    }

    #[test]
    fn quality_level_full_fields() {
        let q = QualityLevel {
            bitrate_bps: Some(2_500_000),
            width: Some(1280),
            height: Some(720),
            framerate: Some(29.97),
            codec: Some("avc1.4d401f".to_string()),
        };
        let json = serde_json::to_string(&q).unwrap();
        assert!(json.contains("\"width\":1280"));
        assert!(json.contains("\"height\":720"));
        assert!(json.contains("\"framerate\":29.97"));
    }

    #[test]
    fn player_error_omits_message_when_none() {
        let e = PlayerError { code: "ERR_NET".to_string(), message: None, fatal: false };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"code\":\"ERR_NET\""));
        assert!(json.contains("\"fatal\":false"));
        assert!(!json.contains("message"));
    }

    #[test]
    fn player_error_includes_message_when_present() {
        let e = PlayerError {
            code: "ERR_NET".to_string(),
            message: Some("timeout".to_string()),
            fatal: true,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"message\":\"timeout\""));
        assert!(json.contains("\"fatal\":true"));
    }

    // ── Metrics serialization ────────────────────────────────────────────────

    #[test]
    fn metrics_serializes_null_vst_as_json_null() {
        let m = Metrics::new();
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"vst_ms\":null"), "got: {}", json);
        assert!(json.contains("\"played_ms\":0"));
        assert!(json.contains("\"rebuffer_count\":0"));
    }

    #[test]
    fn metrics_roundtrips_through_json() {
        let m = Metrics {
            vst_ms: Some(1280),
            played_ms: 14140,
            rebuffer_ms: 2100,
            watched_ms: 17520,
            rebuffer_count: 1,
            error_count: 0,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: Metrics = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
