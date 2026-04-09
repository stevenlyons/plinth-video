use uuid::Uuid;

use crate::beacon::{
    Beacon, BeaconEvent, ClientMetadata, PlayerError, SdkMetadata, VideoMetadata,
};
use crate::config::Config;
use crate::event::PlayerEvent;
use crate::metrics::{Metrics, TimeTracker};
use crate::state::PlayerState;

// ── Session metadata ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, miniserde::Deserialize)]
pub struct SessionMeta {
    pub video: VideoMetadata,
    pub client: ClientMetadata,
    pub sdk: SdkMetadata,
}

// ── Session ───────────────────────────────────────────────────────────────────

pub struct Session {
    config: Config,
    meta: SessionMeta,
    state: PlayerState,
    /// Tracks which state was active when seekStart fired (seek guard).
    pre_seek_state: Option<PlayerState>,
    seq: u32,
    play_id: String,
    /// Counters accumulated across the session (not covered by trackers).
    rebuffer_count: u32,
    error_count: u32,
    /// Persisted VST once first_frame is seen.
    vst_ms: Option<u64>,
    watch_tracker: TimeTracker,
    played_tracker: TimeTracker,
    rebuffer_tracker: TimeTracker,
    /// Timestamp (ms) when the current play attempt started; used to compute VST.
    play_attempt_ts: Option<u64>,
    /// Playhead position at the time seekStart fired; echoed on seek_end.
    seek_from_ms: Option<u64>,
    /// Last time a heartbeat was emitted; None if no session is active.
    last_heartbeat_ms: Option<u64>,
    /// Playhead position reported by the platform; included in heartbeat beacons.
    playhead_ms: u64,
}

impl Session {
    pub fn new(config: Config, meta: SessionMeta, now_ms: u64) -> Self {
        Session {
            config,
            meta,
            state: PlayerState::Idle,
            pre_seek_state: None,
            seq: 0,
            play_id: String::new(),
            rebuffer_count: 0,
            error_count: 0,
            vst_ms: None,
            watch_tracker: TimeTracker::new(),
            played_tracker: TimeTracker::new(),
            rebuffer_tracker: TimeTracker::new(),
            play_attempt_ts: None,
            seek_from_ms: None,
            last_heartbeat_ms: Some(now_ms),
            playhead_ms: 0,
        }
    }

    pub fn state(&self) -> PlayerState {
        self.state
    }

    /// Update the platform-reported playhead position (used in heartbeat beacons).
    pub fn set_playhead(&mut self, playhead_ms: u64) {
        self.playhead_ms = playhead_ms;
    }

    /// Return the last playhead position reported by the platform, in milliseconds.
    pub fn get_playhead(&self) -> u64 {
        self.playhead_ms
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Transition to Error, increment error_count, and return an error beacon.
    /// Callers must stop any running trackers *before* calling this.
    fn emit_error(&mut self, code: String, message: Option<String>, fatal: bool, now_ms: u64) -> Beacon {
        self.state = PlayerState::Error;
        self.error_count += 1;
        let m = self.snapshot_metrics(now_ms);
        let mut b = self.make_beacon(BeaconEvent::Error, Some(PlayerState::Error), Some(m), now_ms);
        b.error = Some(PlayerError { code, message, fatal });
        b
    }

    fn snapshot_metrics(&self, now_ms: u64) -> Metrics {
        Metrics {
            vst_ms: self.vst_ms,
            played_ms: self.played_tracker.current(now_ms),
            rebuffer_ms: self.rebuffer_tracker.current(now_ms),
            watched_ms: self.watch_tracker.current(now_ms),
            rebuffer_count: self.rebuffer_count,
            error_count: self.error_count,
        }
    }

    fn make_beacon(
        &mut self,
        event: BeaconEvent,
        state: Option<PlayerState>,
        metrics: Option<Metrics>,
        ts: u64,
    ) -> Beacon {
        let seq = self.seq;
        self.seq += 1;
        Beacon {
            seq,
            play_id: self.play_id.clone(),
            ts,
            event,
            state,
            metrics,
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

    /// Reset all session state for a new play session and start timers.
    fn begin_session(&mut self, now_ms: u64) {
        self.play_id = Uuid::new_v4().to_string();
        self.seq = 0;
        self.rebuffer_count = 0;
        self.error_count = 0;
        self.vst_ms = None;
        self.watch_tracker.reset();
        self.played_tracker.reset();
        self.rebuffer_tracker.reset();
        self.play_attempt_ts = Some(now_ms);
        self.watch_tracker.start(now_ms);
        self.last_heartbeat_ms = Some(now_ms);
        self.seek_from_ms = None;
        self.pre_seek_state = None;
        self.playhead_ms = 0;
    }

    /// Emit play beacon (seq=0, no state/metrics). Carries session metadata.
    fn emit_play_open(&mut self, ts: u64) -> Beacon {
        let mut b = self.make_beacon(BeaconEvent::Play, None, None, ts);
        b.video = Some(self.meta.video.clone());
        b.client = Some(self.meta.client.clone());
        b.sdk = Some(self.meta.sdk.clone());
        b
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// Ingest a player event, advance the state machine, and return any beacons to send.
    pub fn process_event(&mut self, event: PlayerEvent, now_ms: u64) -> Vec<Beacon> {
        let mut out: Vec<Beacon> = Vec::new();

        match (self.state, event) {
            // ── Loading ───────────────────────────────────────────────────────
            (PlayerState::Idle, PlayerEvent::Load { .. }) => {
                self.state = PlayerState::Loading;
            }

            (PlayerState::Loading, PlayerEvent::CanPlay) => {
                self.state = PlayerState::Ready;
            }

            (PlayerState::Loading, PlayerEvent::Error { code, message, fatal }) => {
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // Also handle load(newSrc) from Ended → Loading
            (PlayerState::Ended, PlayerEvent::Load { .. }) => {
                self.state = PlayerState::Loading;
            }

            // And Error → Loading (retry)
            (PlayerState::Error, PlayerEvent::Load { .. }) => {
                self.state = PlayerState::Loading;
            }

            // ── Play initiation ───────────────────────────────────────────────
            // Ready → PlayAttempt: new session
            (PlayerState::Ready, PlayerEvent::Play) => {
                self.begin_session(now_ms);
                self.state = PlayerState::PlayAttempt;
                out.push(self.emit_play_open(now_ms));
            }

            // Paused → PlayAttempt: resume (same session, emit playing beacon)
            (PlayerState::Paused, PlayerEvent::Play) => {
                self.state = PlayerState::PlayAttempt;
                let m = self.snapshot_metrics(now_ms);
                let b = self.make_beacon(
                    BeaconEvent::Playing,
                    Some(PlayerState::PlayAttempt),
                    Some(m),
                    now_ms,
                );
                out.push(b);
            }

            // Ended → PlayAttempt: replay — brand new session
            (PlayerState::Ended, PlayerEvent::Play) => {
                self.begin_session(now_ms);
                self.state = PlayerState::PlayAttempt;
                out.push(self.emit_play_open(now_ms));
            }

            // ── PlayAttempt transitions ───────────────────────────────────────
            (PlayerState::PlayAttempt, PlayerEvent::Waiting) => {
                self.state = PlayerState::Buffering;
            }

            // FirstFrame or Playing from PlayAttempt/Buffering → Playing.
            // On first play (vst_ms not yet set): record VST, emit first_frame then playing.
            // On subsequent Playing events (vst_ms already set): no beacons (already playing).
            (PlayerState::PlayAttempt, PlayerEvent::FirstFrame)
            | (PlayerState::PlayAttempt, PlayerEvent::Playing)
            | (PlayerState::Buffering, PlayerEvent::FirstFrame)
            | (PlayerState::Buffering, PlayerEvent::Playing) => {
                self.played_tracker.start(now_ms);
                self.state = PlayerState::Playing;
                if self.vst_ms.is_none() {
                    let vst = now_ms.saturating_sub(self.play_attempt_ts.unwrap_or(now_ms));
                    self.vst_ms = Some(vst);
                    let m = self.snapshot_metrics(now_ms);
                    let b = self.make_beacon(
                        BeaconEvent::FirstFrame,
                        Some(PlayerState::Playing),
                        Some(m.clone()),
                        now_ms,
                    );
                    out.push(b);
                    // Immediately follow first_frame with playing to signal active playback.
                    let b2 = self.make_beacon(
                        BeaconEvent::Playing,
                        Some(PlayerState::Playing),
                        Some(m),
                        now_ms,
                    );
                    out.push(b2);
                }
            }

            (PlayerState::PlayAttempt, PlayerEvent::Error { code, message, fatal }) => {
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // ── Buffering transitions ─────────────────────────────────────────

            (PlayerState::Buffering, PlayerEvent::Error { code, message, fatal }) => {
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // ── Playing transitions ───────────────────────────────────────────
            (PlayerState::Playing, PlayerEvent::Pause) => {
                self.played_tracker.stop(now_ms);
                self.state = PlayerState::Paused;
                let m = self.snapshot_metrics(now_ms);
                let mut b =
                    self.make_beacon(BeaconEvent::Pause, Some(PlayerState::Paused), Some(m), now_ms);
                b.playhead_ms = Some(self.playhead_ms);
                out.push(b);
            }

            (PlayerState::Playing, PlayerEvent::SeekStart { from_ms }) => {
                self.played_tracker.stop(now_ms);
                self.pre_seek_state = Some(PlayerState::Playing);
                self.seek_from_ms = Some(from_ms);
                self.state = PlayerState::Seeking;
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::SeekStart,
                    Some(PlayerState::Seeking),
                    Some(m),
                    now_ms,
                );
                b.seek_from_ms = Some(from_ms);
                out.push(b);
            }

            (PlayerState::Playing, PlayerEvent::Stall) => {
                self.played_tracker.stop(now_ms);
                self.rebuffer_tracker.start(now_ms);
                self.rebuffer_count += 1;
                self.state = PlayerState::Rebuffering;
                let m = self.snapshot_metrics(now_ms);
                let b = self.make_beacon(
                    BeaconEvent::Stall,
                    Some(PlayerState::Rebuffering),
                    Some(m),
                    now_ms,
                );
                out.push(b);
            }

            (PlayerState::Playing, PlayerEvent::Ended) => {
                self.played_tracker.stop(now_ms);
                self.watch_tracker.stop(now_ms);
                self.state = PlayerState::Ended;
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::Completed,
                    Some(PlayerState::Ended),
                    Some(m),
                    now_ms,
                );
                b.playhead_ms = Some(self.playhead_ms);
                out.push(b);
            }

            (PlayerState::Playing, PlayerEvent::Error { code, message, fatal }) => {
                self.played_tracker.stop(now_ms);
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            (PlayerState::Playing, PlayerEvent::QualityChange { quality }) => {
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::QualityChange,
                    Some(PlayerState::Playing),
                    Some(m),
                    now_ms,
                );
                b.quality = Some(quality);
                out.push(b);
            }

            // ── Paused transitions ────────────────────────────────────────────
            (PlayerState::Paused, PlayerEvent::SeekStart { from_ms }) => {
                self.pre_seek_state = Some(PlayerState::Paused);
                self.seek_from_ms = Some(from_ms);
                self.state = PlayerState::Seeking;
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::SeekStart,
                    Some(PlayerState::Seeking),
                    Some(m),
                    now_ms,
                );
                b.seek_from_ms = Some(from_ms);
                out.push(b);
            }

            (PlayerState::Paused, PlayerEvent::Destroy) => {
                self.watch_tracker.stop(now_ms);
                self.state = PlayerState::Idle;
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::Ended,
                    Some(PlayerState::Ended),
                    Some(m),
                    now_ms,
                );
                b.playhead_ms = Some(self.playhead_ms);
                out.push(b);
                self.last_heartbeat_ms = None;
            }

            // ── Seeking transitions ───────────────────────────────────────────
            (PlayerState::Seeking, PlayerEvent::SeekEnd { to_ms, buffer_ready }) => {
                let from_ms = self.seek_from_ms.take();
                let pre = self.pre_seek_state.take().unwrap_or(PlayerState::Playing);

                let next_state = match pre {
                    PlayerState::Playing if buffer_ready => PlayerState::Playing,
                    PlayerState::Playing => PlayerState::Rebuffering,
                    PlayerState::Paused => PlayerState::Paused,
                    _ => PlayerState::Playing,
                };

                self.state = next_state;
                let m = self.snapshot_metrics(now_ms);
                let mut b = self.make_beacon(
                    BeaconEvent::SeekEnd,
                    Some(next_state),
                    Some(m),
                    now_ms,
                );
                b.seek_from_ms = from_ms;
                b.seek_to_ms = Some(to_ms);
                out.push(b);

                // Start appropriate tracker for destination state.
                match next_state {
                    PlayerState::Playing => {
                        self.played_tracker.start(now_ms);
                    }
                    PlayerState::Rebuffering => {
                        self.rebuffer_tracker.start(now_ms);
                        self.rebuffer_count += 1;
                        let m2 = self.snapshot_metrics(now_ms);
                        let b2 = self.make_beacon(
                            BeaconEvent::Stall,
                            Some(PlayerState::Rebuffering),
                            Some(m2),
                            now_ms,
                        );
                        out.push(b2);
                    }
                    _ => {}
                }
            }

            (PlayerState::Seeking, PlayerEvent::Error { code, message, fatal }) => {
                self.pre_seek_state = None;
                self.seek_from_ms = None;
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // ── Rebuffering transitions ───────────────────────────────────────
            (PlayerState::Rebuffering, PlayerEvent::Playing) => {
                self.rebuffer_tracker.stop(now_ms);
                self.played_tracker.start(now_ms);
                self.state = PlayerState::Playing;
                let m = self.snapshot_metrics(now_ms);
                let b = self.make_beacon(
                    BeaconEvent::Playing,
                    Some(PlayerState::Playing),
                    Some(m),
                    now_ms,
                );
                out.push(b);
            }

            (PlayerState::Rebuffering, PlayerEvent::Pause) => {
                self.rebuffer_tracker.stop(now_ms);
                self.state = PlayerState::Paused;
                // Emit playing to close the rebuffer interval, then pause.
                let m = self.snapshot_metrics(now_ms);
                let b1 = self.make_beacon(
                    BeaconEvent::Playing,
                    Some(PlayerState::Paused),
                    Some(m.clone()),
                    now_ms,
                );
                out.push(b1);
                let mut b2 = self.make_beacon(
                    BeaconEvent::Pause,
                    Some(PlayerState::Paused),
                    Some(m),
                    now_ms,
                );
                b2.playhead_ms = Some(self.playhead_ms);
                out.push(b2);
            }

            // Seeking from Rebuffering: treat pre_seek_state as Playing (rebuffer interrupted play).
            (PlayerState::Rebuffering, PlayerEvent::SeekStart { from_ms }) => {
                self.rebuffer_tracker.stop(now_ms);
                self.pre_seek_state = Some(PlayerState::Playing);
                self.seek_from_ms = Some(from_ms);
                self.state = PlayerState::Seeking;
                // Emit playing to close the rebuffer interval, then seek_start.
                let m = self.snapshot_metrics(now_ms);
                let b1 = self.make_beacon(
                    BeaconEvent::Playing,
                    Some(PlayerState::Seeking),
                    Some(m.clone()),
                    now_ms,
                );
                out.push(b1);
                let mut b2 = self.make_beacon(
                    BeaconEvent::SeekStart,
                    Some(PlayerState::Seeking),
                    Some(m),
                    now_ms,
                );
                b2.seek_from_ms = Some(from_ms);
                out.push(b2);
            }

            (PlayerState::Rebuffering, PlayerEvent::Error { code, message, fatal }) => {
                self.rebuffer_tracker.stop(now_ms);
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // ── Terminal / reset transitions ───────────────────────────────────
            (PlayerState::Ready, PlayerEvent::Destroy) => {
                self.state = PlayerState::Idle;
            }

            (PlayerState::Ended, PlayerEvent::Destroy) => {
                self.state = PlayerState::Idle;
            }

            (PlayerState::Error, PlayerEvent::Destroy) => {
                self.state = PlayerState::Idle;
            }

            // ── Error from pre-session states ─────────────────────────────────
            (PlayerState::Idle, PlayerEvent::Error { code, message, fatal })
            | (PlayerState::Ready, PlayerEvent::Error { code, message, fatal })
            | (PlayerState::Ended, PlayerEvent::Error { code, message, fatal }) => {
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            (PlayerState::Paused, PlayerEvent::Error { code, message, fatal }) => {
                self.watch_tracker.stop(now_ms);
                out.push(self.emit_error(code, message, fatal, now_ms));
            }

            // Ignore all other (state, event) combinations (invalid transitions).
            _ => {}
        }

        // Reset the heartbeat countdown whenever any beacon is emitted so that
        // heartbeat fires only if the session has been silent for the full interval.
        if !out.is_empty() {
            if let Some(ref mut last) = self.last_heartbeat_ms {
                *last = now_ms;
            }
        }

        out
    }

    /// Called by the platform on a regular interval. Emits a heartbeat beacon if
    /// `heartbeat_interval_ms` has elapsed since the last beacon (of any type) and
    /// the session is in an active state.
    pub fn tick(&mut self, now_ms: u64) -> Vec<Beacon> {
        let last = match self.last_heartbeat_ms {
            Some(t) => t,
            None => return vec![],
        };

        if now_ms.saturating_sub(last) < self.config.heartbeat_interval_ms {
            return vec![];
        }

        let active = matches!(
            self.state,
            PlayerState::PlayAttempt
                | PlayerState::Buffering
                | PlayerState::Playing
                | PlayerState::Paused
                | PlayerState::Seeking
                | PlayerState::Rebuffering
        );

        if !active {
            return vec![];
        }

        self.last_heartbeat_ms = Some(now_ms);
        let m = self.snapshot_metrics(now_ms);
        let playhead = self.playhead_ms;
        let mut b = self.make_beacon(BeaconEvent::Heartbeat, Some(self.state), Some(m), now_ms);
        b.playhead_ms = Some(playhead);
        vec![b]
    }

    /// Forcefully tear down the session from any state. Emits session_end if an
    /// active session was in progress. Always transitions to Idle.
    pub fn destroy(&mut self, now_ms: u64) -> Vec<Beacon> {
        let mut out = Vec::new();

        let was_active = matches!(
            self.state,
            PlayerState::PlayAttempt
                | PlayerState::Buffering
                | PlayerState::Playing
                | PlayerState::Paused
                | PlayerState::Seeking
                | PlayerState::Rebuffering
        );

        if was_active {
            self.played_tracker.stop(now_ms);
            self.rebuffer_tracker.stop(now_ms);
            self.watch_tracker.stop(now_ms);
            let m = self.snapshot_metrics(now_ms);
            let mut b = self.make_beacon(
                BeaconEvent::Ended,
                Some(PlayerState::Ended),
                Some(m),
                now_ms,
            );
            b.playhead_ms = Some(self.playhead_ms);
            out.push(b);
        }

        self.state = PlayerState::Idle;
        self.pre_seek_state = None;
        self.seek_from_ms = None;
        self.last_heartbeat_ms = None;

        out
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beacon::{BeaconEvent, QualityLevel, SdkComponent};

    fn make_session() -> Session {
        let config = Config::default();
        let meta = SessionMeta {
            video: VideoMetadata {
                id: "vid-001".to_string(),
                title: Some("Test Video".to_string()),
            },
            client: ClientMetadata {
                user_agent: "TestAgent/1.0".to_string(),
            },
            sdk: SdkMetadata {
                api_version: 1,
                core: SdkComponent {
                    name: "plinth-core".to_string(),
                    version: "0.1.0".to_string(),
                },
                framework: SdkComponent {
                    name: "plinth-js".to_string(),
                    version: "0.1.0".to_string(),
                },
                player: SdkComponent {
                    name: "plinth-hlsjs".to_string(),
                    version: "0.1.0".to_string(),
                },
            },
        };
        Session::new(config, meta, 0)
    }

    /// Drive session to the Playing state from scratch; returns the
    /// beacons emitted along the way (play + first_frame + playing).
    fn reach_playing(s: &mut Session, t: u64) -> Vec<Beacon> {
        let mut all = Vec::new();
        all.extend(s.process_event(PlayerEvent::Load { src: "http://example.com/video.m3u8".to_string() }, t));
        all.extend(s.process_event(PlayerEvent::CanPlay, t));
        all.extend(s.process_event(PlayerEvent::Play, t));
        all.extend(s.process_event(PlayerEvent::FirstFrame, t + 1000));
        all
    }

    // ── State machine transitions ────────────────────────────────────────────

    #[test]
    fn idle_to_loading_on_load() {
        let mut s = make_session();
        assert_eq!(s.state(), PlayerState::Idle);
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        assert_eq!(s.state(), PlayerState::Loading);
    }

    #[test]
    fn loading_to_ready_on_can_play() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 100);
        assert_eq!(s.state(), PlayerState::Ready);
    }

    #[test]
    fn ready_to_play_attempt_emits_play() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 100);
        let beacons = s.process_event(PlayerEvent::Play, 200);
        assert_eq!(s.state(), PlayerState::PlayAttempt);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Play);
        assert_eq!(beacons[0].seq, 0);
        assert!(beacons[0].state.is_none());
        assert!(beacons[0].metrics.is_none());
        assert!(beacons[0].video.is_some());
        assert!(beacons[0].client.is_some());
        assert!(beacons[0].sdk.is_some());
    }

    #[test]
    fn play_attempt_waiting_goes_to_buffering() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        s.process_event(PlayerEvent::Play, 0);
        let beacons = s.process_event(PlayerEvent::Waiting, 0);
        assert_eq!(s.state(), PlayerState::Buffering);
        assert!(beacons.is_empty());
    }

    #[test]
    fn first_frame_from_play_attempt_transitions_to_playing() {
        let mut s = make_session();
        let beacons = reach_playing(&mut s, 0);
        assert_eq!(s.state(), PlayerState::Playing);
        // play (seq=0) + first_frame (seq=1) + playing (seq=2)
        assert_eq!(beacons.len(), 3);
        let ff = &beacons[1];
        assert_eq!(ff.event, BeaconEvent::FirstFrame);
        assert_eq!(ff.seq, 1);
        assert_eq!(ff.state, Some(PlayerState::Playing));
        let m = ff.metrics.as_ref().unwrap();
        assert_eq!(m.vst_ms, Some(1000));
        assert_eq!(m.played_ms, 0);
        assert_eq!(m.watched_ms, 1000);
        // playing beacon immediately follows first_frame
        assert_eq!(beacons[2].event, BeaconEvent::Playing);
        assert_eq!(beacons[2].seq, 2);
        assert_eq!(beacons[2].ts, beacons[1].ts);
    }

    #[test]
    fn first_frame_from_buffering_transitions_to_playing() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        s.process_event(PlayerEvent::Play, 0);
        s.process_event(PlayerEvent::Waiting, 0); // → Buffering
        let beacons = s.process_event(PlayerEvent::FirstFrame, 1500);
        assert_eq!(s.state(), PlayerState::Playing);
        // first_frame + playing
        assert_eq!(beacons.len(), 2);
        assert_eq!(beacons[0].event, BeaconEvent::FirstFrame);
        assert_eq!(beacons[1].event, BeaconEvent::Playing);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.vst_ms, Some(1500));
    }

    #[test]
    fn playing_to_paused_emits_pause_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(PlayerEvent::Pause, 5000);
        assert_eq!(s.state(), PlayerState::Paused);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Pause);
        assert_eq!(beacons[0].state, Some(PlayerState::Paused));
        let m = beacons[0].metrics.as_ref().unwrap();
        // played_ms: 5000 - 1000 (started at first_frame ts) = 4000
        assert_eq!(m.played_ms, 4000);
    }

    #[test]
    fn paused_play_emits_playing_beacon_and_resumes_session() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5000);
        let beacons = s.process_event(PlayerEvent::Play, 8000);
        assert_eq!(s.state(), PlayerState::PlayAttempt);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Playing);
        // playing beacon seq should be 4 (0=play, 1=first_frame, 2=playing, 3=pause)
        assert_eq!(beacons[0].seq, 4);
    }

    #[test]
    fn resume_from_pause_no_second_first_frame() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5000);
        s.process_event(PlayerEvent::Play, 8000); // → PlayAttempt, emits playing beacon
        let beacons = s.process_event(PlayerEvent::Playing, 8100); // → Playing (vst_ms already set)
        assert_eq!(s.state(), PlayerState::Playing);
        // No first_frame or playing beacon since vst_ms already set
        assert!(beacons.is_empty());
    }

    #[test]
    fn playing_to_rebuffering_emits_stall() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(PlayerEvent::Stall, 5000);
        assert_eq!(s.state(), PlayerState::Rebuffering);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Stall);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_count, 1);
        assert_eq!(m.rebuffer_ms, 0); // not yet accumulated
    }

    #[test]
    fn rebuffering_to_playing_emits_playing() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000); // → Rebuffering
        let beacons = s.process_event(PlayerEvent::Playing, 7100); // → Playing
        assert_eq!(s.state(), PlayerState::Playing);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Playing);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_ms, 2100);
        assert_eq!(m.rebuffer_count, 1);
    }

    #[test]
    fn playing_to_seeking_emits_seek_start_with_from_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(PlayerEvent::SeekStart { from_ms: 10_000 }, 11_000);
        assert_eq!(s.state(), PlayerState::Seeking);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::SeekStart);
        assert_eq!(beacons[0].seek_from_ms, Some(10_000));
    }

    #[test]
    fn seek_end_buffer_ready_resolves_to_playing() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::SeekStart { from_ms: 10_000 }, 11_000);
        let beacons = s.process_event(
            PlayerEvent::SeekEnd { to_ms: 60_000, buffer_ready: true },
            11_400,
        );
        assert_eq!(s.state(), PlayerState::Playing);
        assert_eq!(beacons.len(), 1);
        let se = &beacons[0];
        assert_eq!(se.event, BeaconEvent::SeekEnd);
        assert_eq!(se.state, Some(PlayerState::Playing));
        assert_eq!(se.seek_from_ms, Some(10_000));
        assert_eq!(se.seek_to_ms, Some(60_000));
    }

    #[test]
    fn seek_end_no_buffer_resolves_to_rebuffering() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::SeekStart { from_ms: 10_000 }, 11_000);
        let beacons = s.process_event(
            PlayerEvent::SeekEnd { to_ms: 60_000, buffer_ready: false },
            11_400,
        );
        // seek_end + stall
        assert_eq!(s.state(), PlayerState::Rebuffering);
        assert_eq!(beacons.len(), 2);
        assert_eq!(beacons[0].event, BeaconEvent::SeekEnd);
        assert_eq!(beacons[0].state, Some(PlayerState::Rebuffering));
        assert_eq!(beacons[1].event, BeaconEvent::Stall);
    }

    #[test]
    fn seek_end_from_paused_resolves_to_paused() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5000);
        s.process_event(PlayerEvent::SeekStart { from_ms: 5000 }, 6000);
        let beacons = s.process_event(
            PlayerEvent::SeekEnd { to_ms: 90_000, buffer_ready: true },
            6_200,
        );
        assert_eq!(s.state(), PlayerState::Paused);
        assert_eq!(beacons[0].state, Some(PlayerState::Paused));
    }

    #[test]
    fn playing_ended_emits_completed() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(PlayerEvent::Ended, 120_000);
        assert_eq!(s.state(), PlayerState::Ended);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Completed);
        assert_eq!(beacons[0].state, Some(PlayerState::Ended));
    }

    #[test]
    fn ended_play_starts_new_session() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Ended, 120_000);
        let first_play_id = {
            s.play_id.clone()
        };
        let beacons = s.process_event(PlayerEvent::Play, 125_000);
        // New play beacon with seq=0 again
        assert_eq!(beacons[0].seq, 0);
        assert_eq!(beacons[0].event, BeaconEvent::Play);
        assert_ne!(beacons[0].play_id, first_play_id);
    }

    #[test]
    fn error_from_playing_emits_error_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(
            PlayerEvent::Error {
                code: "NETWORK_ERROR".to_string(),
                message: Some("timeout".to_string()),
                fatal: true,
            },
            10_000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        let e = beacons[0].error.as_ref().unwrap();
        assert_eq!(e.code, "NETWORK_ERROR");
        assert!(e.fatal);
    }

    #[test]
    fn quality_change_emits_quality_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let quality = QualityLevel {
            bitrate_bps: Some(2_500_000),
            width: Some(1280),
            height: Some(720),
            framerate: Some("29.97".to_string()),
            codec: Some("avc1.4d401f".to_string()),
        };
        let beacons = s.process_event(PlayerEvent::QualityChange { quality }, 2000);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::QualityChange);
        assert!(beacons[0].quality.is_some());
    }

    #[test]
    fn rebuffering_pause_emits_playing_then_pause() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000);
        let beacons = s.process_event(PlayerEvent::Pause, 7000);
        assert_eq!(s.state(), PlayerState::Paused);
        assert_eq!(beacons.len(), 2);
        assert_eq!(beacons[0].event, BeaconEvent::Playing);
        assert_eq!(beacons[1].event, BeaconEvent::Pause);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_ms, 2000);
    }

    #[test]
    fn rebuffering_seek_emits_playing_then_seek_start() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000);
        let beacons = s.process_event(PlayerEvent::SeekStart { from_ms: 4500 }, 6000);
        assert_eq!(s.state(), PlayerState::Seeking);
        assert_eq!(beacons.len(), 2);
        assert_eq!(beacons[0].event, BeaconEvent::Playing);
        assert_eq!(beacons[1].event, BeaconEvent::SeekStart);
    }

    #[test]
    fn invalid_transitions_are_ignored() {
        let mut s = make_session();
        // Waiting from Idle should be a no-op
        let beacons = s.process_event(PlayerEvent::Waiting, 0);
        assert!(beacons.is_empty());
        assert_eq!(s.state(), PlayerState::Idle);
    }

    // ── Time accumulator correctness ─────────────────────────────────────────

    #[test]
    fn played_ms_accumulates_only_while_playing() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // first_frame at t=1000, played starts
        s.process_event(PlayerEvent::Pause, 6000); // played: 5000ms
        s.process_event(PlayerEvent::Play, 10_000); // resume
        s.process_event(PlayerEvent::Playing, 10_000); // → Playing (no elapsed yet)
        let beacons = s.process_event(PlayerEvent::Ended, 13_000); // played: 5000 + 3000 = 8000
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.played_ms, 8000);
    }

    #[test]
    fn rebuffer_ms_accumulates_per_rebuffer() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000); // rebuffer starts
        s.process_event(PlayerEvent::Playing, 7000); // rebuffer ends: +2000
        s.process_event(PlayerEvent::Stall, 10_000); // second rebuffer
        let beacons = s.process_event(PlayerEvent::Playing, 11_500); // +1500
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_ms, 3500);
        assert_eq!(m.rebuffer_count, 2);
    }

    #[test]
    fn watched_ms_includes_all_active_states() {
        let mut s = make_session();
        // play_attempt at t=0, first_frame at t=1000 → watched starts at 0
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 3000);   // watched so far: 3000
        s.process_event(PlayerEvent::Play, 5000);    // still watching (paused counts)
        s.process_event(PlayerEvent::Playing, 5000);
        let beacons = s.process_event(PlayerEvent::Ended, 8000); // total: 8000
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.watched_ms, 8000);
    }

    #[test]
    fn vst_ms_is_null_until_first_frame() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(PlayerEvent::Play, 0);
        // play beacon has no metrics
        assert!(beacons[0].metrics.is_none());
        // simulate first_frame 1.3s later → emits first_frame + playing
        let beacons = s.process_event(PlayerEvent::FirstFrame, 1300);
        assert_eq!(beacons[0].event, BeaconEvent::FirstFrame);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.vst_ms, Some(1300));
    }

    // ── Heartbeat interval logic ─────────────────────────────────────────────

    #[test]
    fn tick_emits_heartbeat_at_interval() {
        let mut s = make_session();
        // reach_playing sends FirstFrame at t=1000, so last_heartbeat_ms = 1000.
        // Heartbeat fires when 10s have elapsed since the last beacon.
        reach_playing(&mut s, 0);
        // Tick at 9s — only 8s since last beacon (first_frame at t=1000) — silent
        assert!(s.tick(9_000).is_empty());
        // Tick at 11s — 10s since last beacon — should emit heartbeat
        let beacons = s.tick(11_000);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Heartbeat);
        assert!(beacons[0].playhead_ms.is_some());
    }

    #[test]
    fn tick_does_not_emit_before_session_starts() {
        let mut s = make_session();
        assert!(s.tick(100_000).is_empty());
    }

    #[test]
    fn tick_does_not_emit_after_session_ends() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Ended, 5000);
        assert!(s.tick(20_000).is_empty());
    }

    #[test]
    fn heartbeat_seq_increments_correctly() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // seq 0=play, 1=first_frame, 2=playing (all at t=1000)
        // Heartbeat fires 10s after last beacon (playing at t=1000) → t=11000
        let beacons = s.tick(11_000);
        assert_eq!(beacons[0].seq, 3);
    }

    // ── Beacon serialization ─────────────────────────────────────────────────

    #[test]
    fn session_open_serializes_without_state_or_metrics() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(PlayerEvent::Play, 1_708_646_400_000);
        let b = &beacons[0];
        let json = miniserde::json::to_string(b);
        assert!(!json.contains("\"state\""));
        assert!(!json.contains("\"metrics\""));
        assert!(json.contains("\"event\":\"play\""));
        assert!(json.contains("\"video\""));
        assert!(json.contains("\"client\""));
        assert!(json.contains("\"sdk\""));
    }

    #[test]
    fn first_frame_beacon_matches_sample_shape() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        s.process_event(PlayerEvent::Play, 1_708_646_400_000);
        let beacons = s.process_event(PlayerEvent::FirstFrame, 1_708_646_401_280);
        // beacons[0] = first_frame, beacons[1] = playing
        let b = &beacons[0];
        let json = miniserde::json::to_string(b);
        // Should have state and metrics but NOT video/client/sdk
        assert!(json.contains("\"state\":\"playing\""));
        assert!(json.contains("\"vst_ms\":1280"));
        assert!(json.contains("\"played_ms\":0"));
        assert!(!json.contains("\"video\""));
    }

    #[test]
    fn heartbeat_beacon_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // last beacon at t=1000
        s.set_playhead(10_000);
        let beacons = s.tick(11_000); // 10s after last beacon
        let json = miniserde::json::to_string(&beacons[0]);
        assert!(json.contains("\"playhead_ms\":10000"));
        assert!(!json.contains("\"seek_from_ms\""));
    }

    #[test]
    fn seek_beacons_do_not_include_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.process_event(PlayerEvent::SeekStart { from_ms: 5000 }, 6000);
        let json = miniserde::json::to_string(&beacons[0]);
        assert!(!json.contains("\"playhead_ms\""));
        assert!(json.contains("\"seek_from_ms\":5000"));
    }

    #[test]
    fn destroy_from_playing_emits_ended() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        let beacons = s.destroy(8000);
        assert_eq!(s.state(), PlayerState::Idle);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Ended);
    }

    #[test]
    fn destroy_from_idle_emits_nothing() {
        let mut s = make_session();
        let beacons = s.destroy(0);
        assert!(beacons.is_empty());
        assert_eq!(s.state(), PlayerState::Idle);
    }

    #[test]
    fn seq_resets_on_new_session() {
        let mut s = make_session();
        let all1 = reach_playing(&mut s, 0); // 3 beacons (seq 0=play, 1=first_frame, 2=playing)
        assert_eq!(all1.last().unwrap().seq, 2);
        s.process_event(PlayerEvent::Ended, 5000);
        // Replay
        s.process_event(PlayerEvent::Play, 6000); // new play → seq=0
        assert_eq!(s.seq, 1); // next seq will be 1
    }

    // ── Error-path transitions ────────────────────────────────────────────────

    #[test]
    fn loading_error_emits_error_beacon() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "MANIFEST_ERR".to_string(), message: None, fatal: true },
            500,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        assert_eq!(beacons[0].error.as_ref().unwrap().code, "MANIFEST_ERR");
    }

    #[test]
    fn play_attempt_error_emits_error_beacon_with_metrics() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        s.process_event(PlayerEvent::Play, 0);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "DECODE_ERR".to_string(), message: None, fatal: true },
            1000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.error_count, 1);
        assert_eq!(m.watched_ms, 1000);
    }

    #[test]
    fn buffering_error_emits_error_beacon() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        s.process_event(PlayerEvent::Play, 0);
        s.process_event(PlayerEvent::Waiting, 0); // → Buffering
        let beacons = s.process_event(
            PlayerEvent::Error { code: "NETWORK_ERR".to_string(), message: None, fatal: true },
            2000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.watched_ms, 2000);
    }

    #[test]
    fn seeking_error_emits_error_beacon_and_clears_seek_state() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::SeekStart { from_ms: 5000 }, 5000);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "SEEK_ERR".to_string(), message: None, fatal: true },
            5500,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        // Seek from next session should not carry stale from_ms
        s.process_event(PlayerEvent::Load { src: "x".into() }, 6000);
        s.process_event(PlayerEvent::CanPlay, 6000);
        let open = s.process_event(PlayerEvent::Play, 6000);
        assert_eq!(open[0].seq, 0, "new session should reset seq");
    }

    #[test]
    fn rebuffering_error_stops_rebuffer_timer_in_metrics() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000); // rebuffer starts
        let beacons = s.process_event(
            PlayerEvent::Error { code: "STALL_ERR".to_string(), message: None, fatal: true },
            7000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        let m = beacons[0].metrics.as_ref().unwrap();
        // rebuffer timer should have been stopped: 7000 - 5000 = 2000ms
        assert_eq!(m.rebuffer_ms, 2000);
        assert_eq!(m.rebuffer_count, 1);
    }

    #[test]
    fn idle_error_emits_error_beacon() {
        let mut s = make_session();
        let beacons = s.process_event(
            PlayerEvent::Error { code: "PRE_LOAD_ERR".to_string(), message: None, fatal: true },
            100,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        assert_eq!(beacons[0].error.as_ref().unwrap().code, "PRE_LOAD_ERR");
        assert_eq!(beacons[0].metrics.as_ref().unwrap().error_count, 1);
    }

    #[test]
    fn ready_error_emits_error_beacon() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "READY_ERR".to_string(), message: None, fatal: true },
            500,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        assert_eq!(beacons[0].error.as_ref().unwrap().code, "READY_ERR");
    }

    #[test]
    fn paused_error_stops_watch_timer_and_emits_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5000);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "PAUSED_ERR".to_string(), message: None, fatal: true },
            8000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        // watch_tracker was running in Paused; must be stopped at t=8000
        assert_eq!(beacons[0].metrics.as_ref().unwrap().watched_ms, 8000);
    }

    #[test]
    fn ended_error_emits_error_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Ended, 5000);
        let beacons = s.process_event(
            PlayerEvent::Error { code: "POST_END_ERR".to_string(), message: None, fatal: true },
            6000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Error);
        assert_eq!(beacons[0].error.as_ref().unwrap().code, "POST_END_ERR");
    }

    // ── Error recovery paths ──────────────────────────────────────────────────

    #[test]
    fn error_load_retries_to_loading() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(
            PlayerEvent::Error { code: "ERR".to_string(), message: None, fatal: true },
            5000,
        );
        assert_eq!(s.state(), PlayerState::Error);
        let beacons = s.process_event(PlayerEvent::Load { src: "retry.m3u8".into() }, 6000);
        assert_eq!(s.state(), PlayerState::Loading);
        assert!(beacons.is_empty(), "load from error emits no beacon");
    }

    #[test]
    fn error_destroy_goes_to_idle() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(
            PlayerEvent::Error { code: "ERR".to_string(), message: None, fatal: true },
            5000,
        );
        let beacons = s.process_event(PlayerEvent::Destroy, 6000);
        assert_eq!(s.state(), PlayerState::Idle);
        assert!(beacons.is_empty(), "destroy from error emits no beacon");
    }

    // ── Additional reset / destroy paths ────────────────────────────────────

    #[test]
    fn ready_destroy_goes_to_idle_without_beacon() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(PlayerEvent::Destroy, 1000);
        assert_eq!(s.state(), PlayerState::Idle);
        assert!(beacons.is_empty(), "no session started, no beacon expected");
    }

    #[test]
    fn paused_destroy_via_process_event_emits_ended() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5000);
        let beacons = s.process_event(PlayerEvent::Destroy, 8000);
        assert_eq!(s.state(), PlayerState::Idle);
        assert_eq!(beacons.len(), 1);
        assert_eq!(beacons[0].event, BeaconEvent::Ended);
        let m = beacons[0].metrics.as_ref().unwrap();
        assert_eq!(m.watched_ms, 8000);
    }

    #[test]
    fn ended_destroy_goes_to_idle_without_extra_beacon() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Ended, 5000);
        let beacons = s.process_event(PlayerEvent::Destroy, 6000);
        assert_eq!(s.state(), PlayerState::Idle);
        assert!(beacons.is_empty(), "session already ended, no extra beacon");
    }

    #[test]
    fn ended_load_new_src_goes_to_loading() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Ended, 5000);
        s.process_event(PlayerEvent::Load { src: "new.m3u8".into() }, 6000);
        assert_eq!(s.state(), PlayerState::Loading);
    }

    // ── play_id / session identity ────────────────────────────────────────────

    #[test]
    fn play_id_looks_like_uuid_v4() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        // pull play_id from the session_open beacon
        // (we need to re-run to capture it — use a fresh session)
        let mut s2 = make_session();
        s2.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s2.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s2.process_event(PlayerEvent::Play, 0);
        let play_id = &beacons[0].play_id;
        let parts: Vec<&str> = play_id.split('-').collect();
        assert_eq!(parts.len(), 5, "UUID should have 5 parts: {}", play_id);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        assert!(play_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn play_ids_are_unique_across_sessions() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let b1 = s.process_event(PlayerEvent::Play, 0);
        let id1 = b1[0].play_id.clone();

        s.process_event(PlayerEvent::FirstFrame, 1000);
        s.process_event(PlayerEvent::Ended, 5000);

        let b2 = s.process_event(PlayerEvent::Play, 6000);
        let id2 = b2[0].play_id.clone();

        assert_ne!(id1, id2, "each session must get a distinct play_id");
    }

    #[test]
    fn all_beacons_in_session_share_play_id() {
        let mut s = make_session();
        let all = reach_playing(&mut s, 0);
        let play_id = &all[0].play_id;
        for b in &all {
            assert_eq!(&b.play_id, play_id, "beacon seq={} has wrong play_id", b.seq);
        }
    }

    // ── Heartbeat additional coverage ────────────────────────────────────────

    #[test]
    fn multiple_heartbeats_have_incrementing_seq() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // seq 0,1,2; last beacon at t=1000
        let h1 = s.tick(11_000); // 10s after last beacon → heartbeat, last=11000
        let h2 = s.tick(21_000); // 10s after h1 → heartbeat
        assert_eq!(h1[0].seq + 1, h2[0].seq);
    }

    #[test]
    fn heartbeat_metrics_advance_with_time() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // first_frame at t=1000; last_heartbeat_ms=1000
        let h1 = s.tick(11_000); // 10s after last beacon
        let h2 = s.tick(21_000); // 10s after h1
        let m1 = h1[0].metrics.as_ref().unwrap();
        let m2 = h2[0].metrics.as_ref().unwrap();
        assert!(m2.played_ms > m1.played_ms, "played_ms should grow: {} > {}", m2.played_ms, m1.played_ms);
        assert!(m2.watched_ms > m1.watched_ms);
    }

    #[test]
    fn heartbeat_state_reflects_current_state() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 3000);
        let h = s.tick(15_000);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].state, Some(PlayerState::Paused));
    }

    #[test]
    fn heartbeat_emits_during_rebuffering() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5000); // → Rebuffering
        let h = s.tick(15_000);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].state, Some(PlayerState::Rebuffering));
        let m = h[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_ms, 10_000); // rebuffer running since t=5000
    }

    #[test]
    fn tick_does_not_emit_during_idle_or_loading() {
        let mut s = make_session();
        assert!(s.tick(100_000).is_empty(), "Idle: no heartbeat");
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        assert!(s.tick(100_000).is_empty(), "Loading: no heartbeat");
        s.process_event(PlayerEvent::CanPlay, 0);
        assert!(s.tick(100_000).is_empty(), "Ready: no heartbeat");
    }

    // ── Sample fixture shapes ────────────────────────────────────────────────

    #[test]
    fn rebuffer_sample_fixture_shape() {
        // Mirrors docs/beacon-payload.samples.json "rebuffer" batch shape.
        let mut s = make_session();
        let all = reach_playing(&mut s, 0); // seq=0 play, seq=1 first_frame, seq=2 playing
        let _ = all;

        // stall (seq=3)
        let bs = s.process_event(PlayerEvent::Stall, 15_000);
        assert_eq!(bs[0].event, BeaconEvent::Stall);
        assert_eq!(bs[0].seq, 3);
        let m = bs[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_count, 1);
        assert_eq!(m.rebuffer_ms, 0); // just started

        // playing 2100ms later (seq=4) — stall recovery
        let bs = s.process_event(PlayerEvent::Playing, 17_100);
        assert_eq!(bs[0].event, BeaconEvent::Playing);
        assert_eq!(bs[0].seq, 4);
        assert_eq!(bs[0].state, Some(PlayerState::Playing));
        let m = bs[0].metrics.as_ref().unwrap();
        assert_eq!(m.rebuffer_ms, 2100);
        assert_eq!(m.rebuffer_count, 1);
        assert_eq!(m.vst_ms, Some(1000));
    }

    #[test]
    fn seek_sample_fixture_shape() {
        // Mirrors docs/beacon-payload.samples.json "seek" batch shape.
        let mut s = make_session();
        reach_playing(&mut s, 0); // seq=0 play, seq=1 first_frame, seq=2 playing

        // seek_start (seq=3)
        let bs = s.process_event(PlayerEvent::SeekStart { from_ms: 20_580 }, 22_100);
        assert_eq!(bs[0].event, BeaconEvent::SeekStart);
        assert_eq!(bs[0].seq, 3);
        assert_eq!(bs[0].seek_from_ms, Some(20_580));
        assert!(bs[0].seek_to_ms.is_none());

        // seek_end (seq=4) resolves to playing with buffer ready
        let bs = s.process_event(
            PlayerEvent::SeekEnd { to_ms: 60_000, buffer_ready: true },
            22_480,
        );
        assert_eq!(bs[0].event, BeaconEvent::SeekEnd);
        assert_eq!(bs[0].seq, 4);
        assert_eq!(bs[0].seek_from_ms, Some(20_580));
        assert_eq!(bs[0].seek_to_ms, Some(60_000));
        assert_eq!(bs[0].state, Some(PlayerState::Playing));
    }

    #[test]
    fn session_end_sample_fixture_shape() {
        // Mirrors docs/beacon-payload.samples.json "session_end" batch shape.
        let mut s = make_session();
        reach_playing(&mut s, 0); // first_frame at t=1000
        let bs = s.process_event(PlayerEvent::Ended, 120_000);
        assert_eq!(bs[0].event, BeaconEvent::Completed);
        assert_eq!(bs[0].state, Some(PlayerState::Ended));
        let m = bs[0].metrics.as_ref().unwrap();
        assert!(m.vst_ms.is_some());
        // watched_ms spans from play_attempt (t=0) to ended (t=120_000)
        assert_eq!(m.watched_ms, 120_000);
        // played_ms: first_frame at t=1000, ended at t=120_000 → 119_000ms
        assert_eq!(m.played_ms, 119_000);
    }

    #[test]
    fn session_open_beacon_contains_sdk_metadata() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(PlayerEvent::Play, 0);
        let json = miniserde::json::to_string(&beacons[0]);
        assert!(json.contains("\"api_version\":1"));
        assert!(json.contains("plinth-core"));
        assert!(json.contains("plinth-js"));
        assert!(json.contains("plinth-hlsjs"));
        assert!(json.contains("TestAgent/1.0"));
        assert!(json.contains("vid-001"));
    }

    // ── Playback position tracking ────────────────────────────────────────────

    #[test]
    fn pause_beacon_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.set_playhead(5_000);
        let beacons = s.process_event(PlayerEvent::Pause, 5_000);
        assert_eq!(beacons[0].event, BeaconEvent::Pause);
        assert_eq!(beacons[0].playhead_ms, Some(5_000));
    }

    #[test]
    fn rebuffering_pause_beacon_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Stall, 5_000);
        s.set_playhead(8_000);
        let beacons = s.process_event(PlayerEvent::Pause, 8_000);
        // beacons[0] = playing (stall recovery), beacons[1] = pause
        assert_eq!(beacons[1].event, BeaconEvent::Pause);
        assert_eq!(beacons[1].playhead_ms, Some(8_000));
    }

    #[test]
    fn natural_end_completed_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.set_playhead(120_000);
        let beacons = s.process_event(PlayerEvent::Ended, 120_000);
        assert_eq!(beacons[0].event, BeaconEvent::Completed);
        assert_eq!(beacons[0].playhead_ms, Some(120_000));
    }

    #[test]
    fn paused_destroy_ended_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.process_event(PlayerEvent::Pause, 5_000);
        s.set_playhead(30_000);
        let beacons = s.process_event(PlayerEvent::Destroy, 30_000);
        assert_eq!(beacons[0].event, BeaconEvent::Ended);
        assert_eq!(beacons[0].playhead_ms, Some(30_000));
    }

    #[test]
    fn force_destroy_ended_includes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.set_playhead(15_000);
        let beacons = s.destroy(15_000);
        assert_eq!(beacons[0].event, BeaconEvent::Ended);
        assert_eq!(beacons[0].playhead_ms, Some(15_000));
    }

    #[test]
    fn playhead_ms_defaults_to_zero_when_not_set() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        // No set_playhead call — playhead_ms should be Some(0)
        let beacons = s.process_event(PlayerEvent::Pause, 5_000);
        assert_eq!(beacons[0].playhead_ms, Some(0));
    }

    #[test]
    fn heartbeat_still_includes_playhead_ms_regression() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // last beacon at t=1000
        s.set_playhead(7_000);
        let beacons = s.tick(11_000); // 10s after last beacon
        assert_eq!(beacons[0].event, BeaconEvent::Heartbeat);
        assert_eq!(beacons[0].playhead_ms, Some(7_000));
    }

    #[test]
    fn pause_beacon_serializes_playhead_ms() {
        let mut s = make_session();
        reach_playing(&mut s, 0);
        s.set_playhead(45_000);
        let beacons = s.process_event(PlayerEvent::Pause, 45_000);
        let json = miniserde::json::to_string(&beacons[0]);
        assert!(json.contains("\"playhead_ms\":45000"));
    }

    // ── Beacon lifecycle integration ──────────────────────────────────────────

    /// Drive a full session lifecycle and verify seq values are monotonically
    /// increasing, all beacons share the same play_id, and event types are correct.
    #[test]
    fn full_session_lifecycle_seq_order() {
        let mut s = make_session();
        let mut all: Vec<Beacon> = Vec::new();

        // Load → CanPlay → Play (play beacon — session opens)
        all.extend(s.process_event(PlayerEvent::Load { src: "http://example.com/v.m3u8".into() }, 0));
        all.extend(s.process_event(PlayerEvent::CanPlay, 100));
        all.extend(s.process_event(PlayerEvent::Play, 200));
        // play: seq=0, no state, no metrics
        assert_eq!(all[0].event, BeaconEvent::Play);
        assert_eq!(all[0].seq, 0);
        assert!(all[0].state.is_none());
        assert!(all[0].metrics.is_none());

        let play_id = all[0].play_id.clone();

        // FirstFrame → first_frame (seq=1) + playing (seq=2)
        all.extend(s.process_event(PlayerEvent::FirstFrame, 1_200));
        // Pause → Paused (pause, seq=3)
        all.extend(s.process_event(PlayerEvent::Pause, 5_000));
        // Resume → PlayAttempt (playing, seq=4)
        all.extend(s.process_event(PlayerEvent::Play, 8_000));
        // Playing from PlayAttempt (no beacon — vst_ms already set)
        all.extend(s.process_event(PlayerEvent::Playing, 8_100));
        // SeekStart (seek_start, seq=5)
        all.extend(s.process_event(PlayerEvent::SeekStart { from_ms: 10_000 }, 11_000));
        // SeekEnd buffer_ready → Playing (seek_end, seq=6)
        all.extend(s.process_event(PlayerEvent::SeekEnd { to_ms: 60_000, buffer_ready: true }, 11_400));
        // Ended → completed (seq=7)
        all.extend(s.process_event(PlayerEvent::Ended, 120_000));

        // Verify monotonically increasing seq
        let seqs: Vec<u32> = all.iter().map(|b| b.seq).collect();
        for w in seqs.windows(2) {
            assert!(w[1] == w[0] + 1, "seq not monotonic: {:?}", seqs);
        }

        // All beacons share the same play_id
        for b in &all {
            assert_eq!(b.play_id, play_id, "beacon seq={} has wrong play_id", b.seq);
        }

        // All beacons except session_open have state and metrics
        for b in all.iter().skip(1) {
            assert!(b.state.is_some(), "seq={} missing state", b.seq);
            assert!(b.metrics.is_some(), "seq={} missing metrics", b.seq);
        }
    }

    /// session_open has video/client/sdk but no state, metrics, or playhead_ms.
    #[test]
    fn session_open_beacon_has_required_metadata_fields() {
        let mut s = make_session();
        s.process_event(PlayerEvent::Load { src: "x".into() }, 0);
        s.process_event(PlayerEvent::CanPlay, 0);
        let beacons = s.process_event(PlayerEvent::Play, 0);
        let b = &beacons[0];

        assert_eq!(b.event, BeaconEvent::Play);
        assert!(b.video.is_some(), "video must be present");
        assert!(b.client.is_some(), "client must be present");
        assert!(b.sdk.is_some(), "sdk must be present");
        assert!(b.state.is_none(), "state must be absent on play (session open)");
        assert!(b.metrics.is_none(), "metrics must be absent on play (session open)");
        assert!(b.playhead_ms.is_none(), "playhead_ms must be absent on play (session open)");
    }

    // ── get_playhead ──────────────────────────────────────────────────────────

    #[test]
    fn get_playhead_returns_zero_initially() {
        let s = make_session();
        assert_eq!(s.get_playhead(), 0);
    }

    #[test]
    fn get_playhead_returns_last_set_value() {
        let mut s = make_session();
        s.set_playhead(42_000);
        assert_eq!(s.get_playhead(), 42_000);
        s.set_playhead(99_500);
        assert_eq!(s.get_playhead(), 99_500);
    }

    #[test]
    fn get_playhead_is_included_in_heartbeat_via_set_then_get() {
        let mut s = make_session();
        reach_playing(&mut s, 0); // last beacon at t=1000
        s.set_playhead(10_000);
        assert_eq!(s.get_playhead(), 10_000);
        // Heartbeat fires 10s after last beacon (first_frame at t=1000).
        let beacons = s.tick(11_000);
        let json = miniserde::json::to_string(&beacons[0]);
        assert!(json.contains("\"playhead_ms\":10000"));
    }
}
