use std::borrow::Cow;

use crate::metrics::Metrics;
use crate::state::PlayerState;

miniserde::make_place!(Place);

/// Beacon event type — drives which additional fields are present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeaconEvent {
    /// Session starts; seq=0. Carries video/client/sdk metadata. No state/metrics.
    Play,
    FirstFrame,
    /// Video is actively playing: after first_frame, after stall recovery, after resume.
    Playing,
    Pause,
    SeekStart,
    SeekEnd,
    Stall,
    QualityChange,
    Error,
    Heartbeat,
    /// Session ended by destroy() or user navigation.
    Ended,
    /// Video reached its natural end.
    Completed,
}

impl BeaconEvent {
    fn as_str(&self) -> &'static str {
        match self {
            BeaconEvent::Play => "play",
            BeaconEvent::FirstFrame => "first_frame",
            BeaconEvent::Playing => "playing",
            BeaconEvent::Pause => "pause",
            BeaconEvent::SeekStart => "seek_start",
            BeaconEvent::SeekEnd => "seek_end",
            BeaconEvent::Stall => "stall",
            BeaconEvent::QualityChange => "quality_change",
            BeaconEvent::Error => "error",
            BeaconEvent::Heartbeat => "heartbeat",
            BeaconEvent::Ended => "ended",
            BeaconEvent::Completed => "completed",
        }
    }
}

impl miniserde::ser::Serialize for BeaconEvent {
    fn begin(&self) -> miniserde::ser::Fragment {
        miniserde::ser::Fragment::Str(Cow::Borrowed(self.as_str()))
    }
}

impl miniserde::de::Deserialize for BeaconEvent {
    fn begin(out: &mut Option<Self>) -> &mut dyn miniserde::de::Visitor {
        impl miniserde::de::Visitor for Place<BeaconEvent> {
            fn string(&mut self, s: &str) -> miniserde::Result<()> {
                self.out = Some(match s {
                    "play" => BeaconEvent::Play,
                    "first_frame" => BeaconEvent::FirstFrame,
                    "playing" => BeaconEvent::Playing,
                    "pause" => BeaconEvent::Pause,
                    "seek_start" => BeaconEvent::SeekStart,
                    "seek_end" => BeaconEvent::SeekEnd,
                    "stall" => BeaconEvent::Stall,
                    "quality_change" => BeaconEvent::QualityChange,
                    "error" => BeaconEvent::Error,
                    "heartbeat" => BeaconEvent::Heartbeat,
                    "ended" => BeaconEvent::Ended,
                    "completed" => BeaconEvent::Completed,
                    _ => return Err(miniserde::Error),
                });
                Ok(())
            }
        }
        Place::new(out)
    }
}

/// A single beacon. Flat struct — optional fields are omitted from JSON when None.
#[derive(Debug, Clone)]
pub struct Beacon {
    pub seq: u32,
    pub play_id: String,
    pub ts: u64,
    pub event: BeaconEvent,

    // Present on all beacons except session_open.
    pub state: Option<PlayerState>,
    pub metrics: Option<Metrics>,

    // session_open fields.
    pub video: Option<VideoMetadata>,
    pub client: Option<ClientMetadata>,
    pub sdk: Option<SdkMetadata>,

    // heartbeat field.
    pub playhead_ms: Option<u64>,

    // seek fields (present on seek_start and seek_end).
    pub seek_from_ms: Option<u64>,
    pub seek_to_ms: Option<u64>,

    // quality_change field.
    pub quality: Option<QualityLevel>,

    // error field.
    pub error: Option<PlayerError>,
}

impl miniserde::ser::Serialize for Beacon {
    fn begin(&self) -> miniserde::ser::Fragment {
        struct Map<'a> {
            data: &'a Beacon,
            state: u8,
        }
        impl<'a> miniserde::ser::Map for Map<'a> {
            fn next(&mut self) -> Option<(Cow<str>, &dyn miniserde::ser::Serialize)> {
                loop {
                    let s = self.state;
                    self.state += 1;
                    match s {
                        0 => return Some((Cow::Borrowed("seq"), &self.data.seq)),
                        1 => return Some((Cow::Borrowed("play_id"), &self.data.play_id)),
                        2 => return Some((Cow::Borrowed("ts"), &self.data.ts)),
                        3 => return Some((Cow::Borrowed("event"), &self.data.event)),
                        4 => if let Some(ref v) = self.data.state {
                            return Some((Cow::Borrowed("state"), v));
                        }
                        5 => if let Some(ref v) = self.data.metrics {
                            return Some((Cow::Borrowed("metrics"), v));
                        }
                        6 => if let Some(ref v) = self.data.video {
                            return Some((Cow::Borrowed("video"), v));
                        }
                        7 => if let Some(ref v) = self.data.client {
                            return Some((Cow::Borrowed("client"), v));
                        }
                        8 => if let Some(ref v) = self.data.sdk {
                            return Some((Cow::Borrowed("sdk"), v));
                        }
                        9 => if let Some(ref v) = self.data.playhead_ms {
                            return Some((Cow::Borrowed("playhead_ms"), v));
                        }
                        10 => if let Some(ref v) = self.data.seek_from_ms {
                            return Some((Cow::Borrowed("seek_from_ms"), v));
                        }
                        11 => if let Some(ref v) = self.data.seek_to_ms {
                            return Some((Cow::Borrowed("seek_to_ms"), v));
                        }
                        12 => if let Some(ref v) = self.data.quality {
                            return Some((Cow::Borrowed("quality"), v));
                        }
                        13 => if let Some(ref v) = self.data.error {
                            return Some((Cow::Borrowed("error"), v));
                        }
                        _ => return None,
                    }
                }
            }
        }
        miniserde::ser::Fragment::Map(Box::new(Map { data: self, state: 0 }))
    }
}

/// HTTP POST body — wraps a batch of beacons from a single play session.
#[derive(Debug, Clone, miniserde::Serialize)]
pub struct BeaconBatch {
    pub beacons: Vec<Beacon>,
}

impl BeaconBatch {
    pub fn new(beacons: Vec<Beacon>) -> Self {
        BeaconBatch { beacons }
    }

    pub fn to_json(&self) -> String {
        miniserde::json::to_string(self)
    }
}

// ── Metadata types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, miniserde::Deserialize)]
pub struct VideoMetadata {
    pub id: String,
    pub title: Option<String>,
}

impl miniserde::ser::Serialize for VideoMetadata {
    fn begin(&self) -> miniserde::ser::Fragment {
        struct Map<'a> {
            data: &'a VideoMetadata,
            state: u8,
        }
        impl<'a> miniserde::ser::Map for Map<'a> {
            fn next(&mut self) -> Option<(Cow<str>, &dyn miniserde::ser::Serialize)> {
                loop {
                    let s = self.state;
                    self.state += 1;
                    match s {
                        0 => return Some((Cow::Borrowed("id"), &self.data.id)),
                        1 => if let Some(ref v) = self.data.title {
                            return Some((Cow::Borrowed("title"), v));
                        }
                        _ => return None,
                    }
                }
            }
        }
        miniserde::ser::Fragment::Map(Box::new(Map { data: self, state: 0 }))
    }
}

#[derive(Debug, Clone, miniserde::Serialize, miniserde::Deserialize)]
pub struct ClientMetadata {
    pub user_agent: String,
}

#[derive(Debug, Clone, miniserde::Serialize, miniserde::Deserialize)]
pub struct SdkMetadata {
    pub api_version: u32,
    pub core: SdkComponent,
    pub framework: SdkComponent,
    pub player: SdkComponent,
}

#[derive(Debug, Clone, miniserde::Serialize, miniserde::Deserialize)]
pub struct SdkComponent {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct QualityLevel {
    pub bitrate_bps: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub framerate: Option<String>,
    pub codec: Option<String>,
}

impl miniserde::ser::Serialize for QualityLevel {
    fn begin(&self) -> miniserde::ser::Fragment {
        struct Map<'a> {
            data: &'a QualityLevel,
            state: u8,
        }
        impl<'a> miniserde::ser::Map for Map<'a> {
            fn next(&mut self) -> Option<(Cow<str>, &dyn miniserde::ser::Serialize)> {
                loop {
                    let s = self.state;
                    self.state += 1;
                    match s {
                        0 => if let Some(ref v) = self.data.bitrate_bps {
                            return Some((Cow::Borrowed("bitrate_bps"), v));
                        }
                        1 => if let Some(ref v) = self.data.width {
                            return Some((Cow::Borrowed("width"), v));
                        }
                        2 => if let Some(ref v) = self.data.height {
                            return Some((Cow::Borrowed("height"), v));
                        }
                        3 => if let Some(ref v) = self.data.framerate {
                            return Some((Cow::Borrowed("framerate"), v));
                        }
                        4 => if let Some(ref v) = self.data.codec {
                            return Some((Cow::Borrowed("codec"), v));
                        }
                        _ => return None,
                    }
                }
            }
        }
        miniserde::ser::Fragment::Map(Box::new(Map { data: self, state: 0 }))
    }
}

impl miniserde::de::Deserialize for QualityLevel {
    fn begin(out: &mut Option<Self>) -> &mut dyn miniserde::de::Visitor {
        impl miniserde::de::Visitor for Place<QualityLevel> {
            fn map(&mut self) -> miniserde::Result<Box<dyn miniserde::de::Map + '_>> {
                Ok(Box::new(QualityLevelMap {
                    bitrate_bps: None,
                    width: None,
                    height: None,
                    framerate: None,
                    codec: None,
                    out: &mut self.out,
                }))
            }
        }
        Place::new(out)
    }
}

struct QualityLevelMap<'a> {
    bitrate_bps: Option<Option<u64>>,
    width: Option<Option<u32>>,
    height: Option<Option<u32>>,
    framerate: Option<Option<String>>,
    codec: Option<Option<String>>,
    out: &'a mut Option<QualityLevel>,
}

impl<'a> miniserde::de::Map for QualityLevelMap<'a> {
    fn key(&mut self, k: &str) -> miniserde::Result<&mut dyn miniserde::de::Visitor> {
        match k {
            "bitrate_bps" => Ok(miniserde::de::Deserialize::begin(&mut self.bitrate_bps)),
            "width" => Ok(miniserde::de::Deserialize::begin(&mut self.width)),
            "height" => Ok(miniserde::de::Deserialize::begin(&mut self.height)),
            "framerate" => Ok(miniserde::de::Deserialize::begin(&mut self.framerate)),
            "codec" => Ok(miniserde::de::Deserialize::begin(&mut self.codec)),
            _ => Ok(<dyn miniserde::de::Visitor>::ignore()),
        }
    }

    fn finish(&mut self) -> miniserde::Result<()> {
        *self.out = Some(QualityLevel {
            bitrate_bps: self.bitrate_bps.take().flatten(),
            width: self.width.take().flatten(),
            height: self.height.take().flatten(),
            framerate: self.framerate.take().flatten(),
            codec: self.codec.take().flatten(),
        });
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PlayerError {
    pub code: String,
    pub message: Option<String>,
    pub fatal: bool,
}

impl miniserde::ser::Serialize for PlayerError {
    fn begin(&self) -> miniserde::ser::Fragment {
        struct Map<'a> {
            data: &'a PlayerError,
            state: u8,
        }
        impl<'a> miniserde::ser::Map for Map<'a> {
            fn next(&mut self) -> Option<(Cow<str>, &dyn miniserde::ser::Serialize)> {
                loop {
                    let s = self.state;
                    self.state += 1;
                    match s {
                        0 => return Some((Cow::Borrowed("code"), &self.data.code)),
                        1 => if let Some(ref v) = self.data.message {
                            return Some((Cow::Borrowed("message"), v));
                        }
                        2 => return Some((Cow::Borrowed("fatal"), &self.data.fatal)),
                        _ => return None,
                    }
                }
            }
        }
        miniserde::ser::Fragment::Map(Box::new(Map { data: self, state: 0 }))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── BeaconEvent serialization ────────────────────────────────────────────

    #[test]
    fn beacon_event_serializes_to_snake_case() {
        let cases = [
            (BeaconEvent::Play, "\"play\""),
            (BeaconEvent::FirstFrame, "\"first_frame\""),
            (BeaconEvent::Playing, "\"playing\""),
            (BeaconEvent::Pause, "\"pause\""),
            (BeaconEvent::SeekStart, "\"seek_start\""),
            (BeaconEvent::SeekEnd, "\"seek_end\""),
            (BeaconEvent::Stall, "\"stall\""),
            (BeaconEvent::QualityChange, "\"quality_change\""),
            (BeaconEvent::Error, "\"error\""),
            (BeaconEvent::Heartbeat, "\"heartbeat\""),
            (BeaconEvent::Ended, "\"ended\""),
            (BeaconEvent::Completed, "\"completed\""),
        ];
        for (event, expected) in cases {
            assert_eq!(
                miniserde::json::to_string(&event),
                expected,
                "BeaconEvent::{:?}",
                event
            );
        }
    }

    #[test]
    fn beacon_event_deserializes_from_snake_case() {
        let e: BeaconEvent = miniserde::json::from_str("\"stall\"").unwrap();
        assert_eq!(e, BeaconEvent::Stall);
        let e: BeaconEvent = miniserde::json::from_str("\"play\"").unwrap();
        assert_eq!(e, BeaconEvent::Play);
        let e: BeaconEvent = miniserde::json::from_str("\"playing\"").unwrap();
        assert_eq!(e, BeaconEvent::Playing);
        let e: BeaconEvent = miniserde::json::from_str("\"completed\"").unwrap();
        assert_eq!(e, BeaconEvent::Completed);
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
                miniserde::json::to_string(&state),
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
            let json = miniserde::json::to_string(&state);
            let back: PlayerState = miniserde::json::from_str(&json).unwrap();
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
        let json = miniserde::json::to_string(&b);
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
        let json = miniserde::json::to_string(&b);
        assert!(json.contains("\"state\":\"playing\""));
        assert!(json.contains("\"playhead_ms\":42000"));
        assert!(!json.contains("seek_from_ms"));
    }

    #[test]
    fn beacon_seek_fields_serialized() {
        let mut b = minimal_beacon(BeaconEvent::SeekEnd);
        b.seek_from_ms = Some(10_000);
        b.seek_to_ms = Some(60_000);
        let json = miniserde::json::to_string(&b);
        assert!(json.contains("\"seek_from_ms\":10000"));
        assert!(json.contains("\"seek_to_ms\":60000"));
        assert!(!json.contains("playhead_ms"));
    }

    // ── BeaconBatch ──────────────────────────────────────────────────────────

    #[test]
    fn beacon_batch_wraps_beacons_under_key() {
        let b = minimal_beacon(BeaconEvent::Play);
        let batch = BeaconBatch::new(vec![b]);
        let json = batch.to_json();
        assert!(json.starts_with("{\"beacons\":["), "got: {}", json);
        assert!(json.ends_with("]}"), "got: {}", json);
    }

    #[test]
    fn beacon_batch_preserves_beacon_count() {
        let beacons = vec![
            minimal_beacon(BeaconEvent::Play),
            minimal_beacon(BeaconEvent::FirstFrame),
        ];
        let batch = BeaconBatch::new(beacons);
        let json = batch.to_json();
        assert_eq!(json.matches("\"seq\":").count(), 2);
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
        let batch = BeaconBatch::new(vec![b]);
        let json = batch.to_json();
        assert!(json.contains("\"event\":\"heartbeat\""));
        assert!(json.contains("\"state\":\"playing\""));
        assert!(json.contains("\"playhead_ms\":5000"));
        assert!(json.contains("\"vst_ms\":1000"));
        assert!(json.contains("\"played_ms\":4000"));
    }

    // ── Metadata types ───────────────────────────────────────────────────────

    #[test]
    fn video_metadata_omits_title_when_none() {
        let v = VideoMetadata { id: "vid-1".to_string(), title: None };
        assert_eq!(miniserde::json::to_string(&v), "{\"id\":\"vid-1\"}");
    }

    #[test]
    fn video_metadata_includes_title_when_present() {
        let v = VideoMetadata { id: "vid-1".to_string(), title: Some("My Video".to_string()) };
        let json = miniserde::json::to_string(&v);
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
        let json = miniserde::json::to_string(&q);
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
            framerate: Some("29.97".to_string()),
            codec: Some("avc1.4d401f".to_string()),
        };
        let json = miniserde::json::to_string(&q);
        assert!(json.contains("\"width\":1280"));
        assert!(json.contains("\"height\":720"));
        assert!(json.contains("\"framerate\":\"29.97\""));
    }

    #[test]
    fn player_error_omits_message_when_none() {
        let e = PlayerError { code: "ERR_NET".to_string(), message: None, fatal: false };
        let json = miniserde::json::to_string(&e);
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
        let json = miniserde::json::to_string(&e);
        assert!(json.contains("\"message\":\"timeout\""));
        assert!(json.contains("\"fatal\":true"));
    }

    // ── Metrics serialization ────────────────────────────────────────────────

    #[test]
    fn metrics_serializes_null_vst_as_json_null() {
        let m = Metrics::new();
        let json = miniserde::json::to_string(&m);
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
        let json = miniserde::json::to_string(&m);
        let back: Metrics = miniserde::json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
