/// Cumulative QoE metrics snapshot. All durations are in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, miniserde::Serialize, miniserde::Deserialize)]
pub struct Metrics {
    /// Video Start Time: ms from play_attempt to first_frame. Null until first_frame.
    pub vst_ms: Option<u64>,
    /// Cumulative time spent in the Playing state.
    pub played_ms: u64,
    /// Cumulative time spent in the Rebuffering state.
    pub rebuffer_ms: u64,
    /// Total elapsed ms from play_attempt to now (inclusive of all states).
    pub watched_ms: u64,
    /// Number of discrete stall events (each stall beacon increments this).
    pub rebuffer_count: u32,
    /// Number of error events emitted.
    pub error_count: u32,
    /// Cumulative ms spent in Rebuffering entered via Seeking → Rebuffering.
    pub seek_buffer_ms: u64,
    /// Number of seeks that resulted in buffering (Seeking → Rebuffering).
    pub seek_buffer_count: u32,
    /// Total seek events initiated during the session (Seek events).
    pub seek_count: u32,
}

impl Metrics {
    pub fn new() -> Self {
        Metrics {
            vst_ms: None,
            played_ms: 0,
            rebuffer_ms: 0,
            watched_ms: 0,
            rebuffer_count: 0,
            error_count: 0,
            seek_buffer_ms: 0,
            seek_buffer_count: 0,
            seek_count: 0,
        }
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Stopwatch that accumulates elapsed time across start/stop cycles.
#[derive(Debug, Clone, Default)]
pub struct TimeTracker {
    accumulated_ms: u64,
    start_ms: Option<u64>,
}

impl TimeTracker {
    pub fn new() -> Self {
        TimeTracker {
            accumulated_ms: 0,
            start_ms: None,
        }
    }

    /// Begin a new timing segment. No-op if already running.
    pub fn start(&mut self, now_ms: u64) {
        if self.start_ms.is_none() {
            self.start_ms = Some(now_ms);
        }
    }

    /// End the current segment, adding elapsed time to the accumulator.
    pub fn stop(&mut self, now_ms: u64) {
        if let Some(start) = self.start_ms.take() {
            self.accumulated_ms += now_ms.saturating_sub(start);
        }
    }

    /// Current total including any in-progress segment.
    pub fn current(&self, now_ms: u64) -> u64 {
        match self.start_ms {
            Some(start) => self.accumulated_ms + now_ms.saturating_sub(start),
            None => self.accumulated_ms,
        }
    }

    pub fn reset(&mut self) {
        self.accumulated_ms = 0;
        self.start_ms = None;
    }

    pub fn is_running(&self) -> bool {
        self.start_ms.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_tracker_accumulates_across_segments() {
        let mut t = TimeTracker::new();
        t.start(1000);
        t.stop(1500); // +500
        t.start(2000);
        t.stop(2300); // +300
        assert_eq!(t.current(9999), 800);
    }

    #[test]
    fn time_tracker_current_while_running() {
        let mut t = TimeTracker::new();
        t.start(1000);
        assert_eq!(t.current(1400), 400);
    }

    #[test]
    fn time_tracker_double_start_no_op() {
        let mut t = TimeTracker::new();
        t.start(1000);
        t.start(2000); // ignored
        assert_eq!(t.current(3000), 2000);
    }

    #[test]
    fn time_tracker_stop_when_not_running_no_op() {
        let mut t = TimeTracker::new();
        t.stop(5000); // no-op
        assert_eq!(t.current(9999), 0);
    }

    #[test]
    fn time_tracker_reset_clears_all() {
        let mut t = TimeTracker::new();
        t.start(0);
        t.stop(500);
        t.reset();
        assert_eq!(t.current(9999), 0);
        assert!(!t.is_running());
    }
}
