use crate::beacon::QualityLevel;

miniserde::make_place!(Place);

/// All player inputs that the session state machine can act on.
#[derive(Debug, Clone)]
pub enum PlayerEvent {
    /// Source URL assigned: Idle → Loading.
    Load { src: String },
    /// Metadata / manifest loaded; player can play: Loading → Ready.
    CanPlay,
    /// play() called by user: Ready/Paused/Ended → PlayAttempt.
    Play,
    /// Buffer empty at initial play: PlayAttempt → Buffering.
    Waiting,
    /// Buffer exhausted mid-playback (stall): Playing → Rebuffering.
    Stall,
    /// First decoded frame rendered (once per session): PlayAttempt/Buffering → Playing.
    FirstFrame,
    /// Media `playing` event — fires on any resume (rebuffer recovery or resume from pause).
    /// PlayAttempt/Buffering → Playing (no first_frame beacon if vst already set);
    /// Rebuffering → Playing (emits rebuffer_end beacon).
    Playing,
    /// User or system paused: Playing/Rebuffering → Paused.
    Pause,
    /// Seek initiated. `from_ms` is the playhead position before the seek.
    SeekStart { from_ms: u64 },
    /// Seek completed. `to_ms` is the final playhead position.
    /// `buffer_ready` determines whether seek_end resolves to Playing or Rebuffering
    /// when `pre_seek_state` was Playing.
    SeekEnd { to_ms: u64, buffer_ready: bool },
    /// Video reached natural end: Playing → Ended.
    Ended,
    /// Player error occurred.
    Error {
        code: String,
        message: Option<String>,
        fatal: bool,
    },
    /// SDK destroyed; graceful teardown from Ready/Paused/Ended/Error.
    Destroy,
    /// Rendition quality changed while Playing.
    QualityChange { quality: QualityLevel },
}

impl miniserde::de::Deserialize for PlayerEvent {
    fn begin(out: &mut Option<Self>) -> &mut dyn miniserde::de::Visitor {
        impl miniserde::de::Visitor for Place<PlayerEvent> {
            fn map(&mut self) -> miniserde::Result<Box<dyn miniserde::de::Map + '_>> {
                Ok(Box::new(PlayerEventMap {
                    type_: None,
                    src: None,
                    from_ms: None,
                    to_ms: None,
                    buffer_ready: None,
                    code: None,
                    message: None,
                    fatal: None,
                    quality: None,
                    out: &mut self.out,
                }))
            }
        }
        Place::new(out)
    }
}

struct PlayerEventMap<'a> {
    type_: Option<String>,
    src: Option<String>,
    from_ms: Option<u64>,
    to_ms: Option<u64>,
    buffer_ready: Option<bool>,
    code: Option<String>,
    message: Option<Option<String>>,
    fatal: Option<bool>,
    quality: Option<QualityLevel>,
    out: &'a mut Option<PlayerEvent>,
}

impl<'a> miniserde::de::Map for PlayerEventMap<'a> {
    fn key(&mut self, k: &str) -> miniserde::Result<&mut dyn miniserde::de::Visitor> {
        match k {
            "type" => Ok(miniserde::de::Deserialize::begin(&mut self.type_)),
            "src" => Ok(miniserde::de::Deserialize::begin(&mut self.src)),
            "from_ms" => Ok(miniserde::de::Deserialize::begin(&mut self.from_ms)),
            "to_ms" => Ok(miniserde::de::Deserialize::begin(&mut self.to_ms)),
            "buffer_ready" => Ok(miniserde::de::Deserialize::begin(&mut self.buffer_ready)),
            "code" => Ok(miniserde::de::Deserialize::begin(&mut self.code)),
            "message" => Ok(miniserde::de::Deserialize::begin(&mut self.message)),
            "fatal" => Ok(miniserde::de::Deserialize::begin(&mut self.fatal)),
            "quality" => Ok(miniserde::de::Deserialize::begin(&mut self.quality)),
            _ => Ok(<dyn miniserde::de::Visitor>::ignore()),
        }
    }

    fn finish(&mut self) -> miniserde::Result<()> {
        let type_ = self.type_.take().ok_or(miniserde::Error)?;
        *self.out = Some(match type_.as_str() {
            "load" => PlayerEvent::Load {
                src: self.src.take().ok_or(miniserde::Error)?,
            },
            "can_play" => PlayerEvent::CanPlay,
            "play" => PlayerEvent::Play,
            "waiting" => PlayerEvent::Waiting,
            "stall" => PlayerEvent::Stall,
            "first_frame" => PlayerEvent::FirstFrame,
            "playing" => PlayerEvent::Playing,
            "pause" => PlayerEvent::Pause,
            "seek_start" => PlayerEvent::SeekStart {
                from_ms: self.from_ms.take().ok_or(miniserde::Error)?,
            },
            "seek_end" => PlayerEvent::SeekEnd {
                to_ms: self.to_ms.take().ok_or(miniserde::Error)?,
                buffer_ready: self.buffer_ready.take().ok_or(miniserde::Error)?,
            },
            "ended" => PlayerEvent::Ended,
            "error" => PlayerEvent::Error {
                code: self.code.take().ok_or(miniserde::Error)?,
                message: self.message.take().flatten(),
                fatal: self.fatal.take().ok_or(miniserde::Error)?,
            },
            "destroy" => PlayerEvent::Destroy,
            "quality_change" => PlayerEvent::QualityChange {
                quality: self.quality.take().ok_or(miniserde::Error)?,
            },
            _ => return Err(miniserde::Error),
        });
        Ok(())
    }
}
