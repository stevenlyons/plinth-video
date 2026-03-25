import AVFoundation
import PlinthApple

// MARK: - Public types

public typealias AVPlayerSessionFactory = (SessionMeta, PlinthConfig) -> PlinthSession?

public struct AVVideoMeta {
    public var id: String
    public var title: String?

    public init(id: String, title: String? = nil) {
        self.id = id
        self.title = title
    }
}

// MARK: - PlinthAVPlayer

/// Layer-3 AVPlayer integration for plinth-telemetry.
///
/// Maps AVPlayer KVO observations and notifications to `PlinthSession` events.
///
/// **Seek tracking:** Call `seek(to:)` on this instance instead of on the player
/// directly. This lets the SDK record `seek_start`/`seek_end` accurately.
///
/// **Lifecycle:**
/// ```swift
/// let plinth = PlinthAVPlayer.initialize(player: player, videoMeta: meta)
/// // play, pause, seek via plinth.seek(to:) …
/// plinth.destroy()  // call before releasing the player
/// ```
public final class PlinthAVPlayer {

    // MARK: Options

    public struct Options {
        /// Overrides the default config (endpoint, project key, heartbeat interval).
        public var config: PlinthConfig
        /// Test seam: replace `PlinthSession.create` with a custom factory.
        public var sessionFactory: AVPlayerSessionFactory?

        public init(
            config: PlinthConfig = .default,
            sessionFactory: AVPlayerSessionFactory? = nil
        ) {
            self.config = config
            self.sessionFactory = sessionFactory
        }
    }

    // MARK: Private state

    private let player: AVPlayer
    internal var session: PlinthSession?
    private var isDestroyed = false

    /// True once the first `.playing` timeControlStatus is observed after a play attempt.
    private var hasFiredFirstFrame = false
    /// True while `seek(to:)` wrapper is in flight — prevents double seek events from periodic observer.
    private var isHandlingProgrammaticSeek = false
    /// Last observed playhead (ms) — used as `from_ms` on seek start.
    private(set) var lastPlayheadMs: UInt64 = 0

    // Seek state machine — coalesces multiple jumping periodic ticks into one seek pair.
    private var seekInProgress = false
    private var seekCandidateFromMs: UInt64 = 0
    private var seekCandidateToMs: UInt64 = 0

    // KVO observations (cancelled in destroy)
    private var currentItemObservation: NSKeyValueObservation?
    private var timeControlObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var itemStatusObservation: NSKeyValueObservation?

    // Notification observer tokens
    private var notificationTokens: [NSObjectProtocol] = []

    // Periodic time observer token
    private var timeObserverToken: Any?

    // MARK: - Factory

    /// Initialize the SDK for the given player.
    ///
    /// - Parameters:
    ///   - player:    The `AVPlayer` instance to monitor.
    ///   - videoMeta: Metadata about the video being played.
    ///   - options:   Optional config and session factory overrides.
    /// - Returns: A configured `PlinthAVPlayer` with observers attached.
    @discardableResult
    public static func initialize(
        player: AVPlayer,
        videoMeta: AVVideoMeta,
        options: Options = Options()
    ) -> PlinthAVPlayer {
        let factory: AVPlayerSessionFactory = options.sessionFactory ?? { meta, config in
            PlinthSession.create(meta: meta, config: config)
        }

        let userAgent = platformUserAgent()
        let meta = SessionMeta(
            video: VideoMetadata(id: videoMeta.id, title: videoMeta.title),
            client: ClientMetadata(userAgent: userAgent),
            sdk: SdkMetadata(
                apiVersion: 1,
                core: SdkComponent(name: "plinth-core", version: "0.1.0"),
                framework: SdkComponent(name: "plinth-apple", version: "0.1.0"),
                player: SdkComponent(name: "plinth-avplayer", version: "0.1.0")
            )
        )

        let instance = PlinthAVPlayer(player: player)
        instance.session = factory(meta, options.config)
        instance.attachObservers()

        // If the player already has an item, emit Load immediately.
        if let item = player.currentItem,
           let url = (item.asset as? AVURLAsset)?.url {
            instance.handleLoad(src: url.absoluteString)
            instance.observeItemStatus(item)
        }

        return instance
    }

    private init(player: AVPlayer) {
        self.player = player
    }

    deinit {
        if !isDestroyed { destroy() }
    }

    // MARK: - Public API

    /// Seek the player to `time`, emitting `seek_start` and `seek_end` events.
    ///
    /// Use this instead of calling `player.seek(to:)` directly when you want
    /// zero-tolerance seeking with accurate seek metrics. The SDK also detects
    /// seeks automatically via the periodic time observer for scrubber-initiated seeks.
    public func seek(to time: CMTime) {
        guard !isDestroyed else { return }
        seekInProgress = false  // cancel any pending periodic seek
        let fromMs = lastPlayheadMs
        isHandlingProgrammaticSeek = true
        session?.processEvent(.seekStart(fromMs: fromMs))

        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self, !self.isDestroyed else {
                self?.isHandlingProgrammaticSeek = false
                return
            }
            let toMs = UInt64(max(0, CMTimeGetSeconds(time)) * 1000)
            self.lastPlayheadMs = toMs  // prevent periodic observer from double-detecting
            self.isHandlingProgrammaticSeek = false
            let bufferReady = self.player.currentItem?.isPlaybackLikelyToKeepUp ?? false
            self.session?.processEvent(.seekEnd(toMs: toMs, bufferReady: bufferReady))
        }
    }

    /// Return the last playhead position reported by the platform, in milliseconds.
    public func getPlayhead() -> UInt64 {
        return session?.getPlayhead() ?? 0
    }

    /// Tear down all observers and post any final beacons. Idempotent.
    public func destroy() {
        guard !isDestroyed else { return }
        isDestroyed = true
        detachObservers()
        session?.destroy()
        session = nil
    }

    // MARK: - Internal event handlers (called by KVO/notifications; also used by tests)

    internal func handleLoad(src: String) {
        hasFiredFirstFrame = false
        seekInProgress = false
        session?.processEvent(.load(src: src))
    }

    internal func handleCanPlay() {
        session?.processEvent(.canPlay)
    }

    internal func handlePlay() {
        session?.processEvent(.play)
    }

    internal func handleWaiting() {
        session?.processEvent(.waiting)
    }

    internal func handleFirstFrame() {
        hasFiredFirstFrame = true
        session?.processEvent(.firstFrame)
    }

    internal func handleCanPlayThrough() {
        session?.processEvent(.canPlayThrough)
    }

    internal func handlePause() {
        session?.processEvent(.pause)
    }

    internal func handleEnded() {
        session?.processEvent(.ended)
    }

    internal func handleError(code: String, message: String?, fatal: Bool) {
        session?.processEvent(.error(code: code, message: message, fatal: fatal))
    }

    internal func handleQualityChange(bitrateBps: Int?, width: Int?, height: Int?) {
        let quality = QualityLevel(bitrateBps: bitrateBps, width: width, height: height)
        session?.processEvent(.qualityChange(quality: quality))
    }

    // MARK: - KVO & notification wiring

    private func attachObservers() {
        // ── currentItem ──────────────────────────────────────────────────────
        currentItemObservation = player.observe(\.currentItem, options: [.new, .old]) {
            [weak self] player, change in
            guard let self else { return }
            // Ignore first-fire when old and new are the same (initial value).
            guard change.oldValue != change.newValue else { return }

            if let item = change.newValue as? AVPlayerItem {
                let src = (item.asset as? AVURLAsset)?.url.absoluteString ?? "unknown"
                self.handleLoad(src: src)
                self.observeItemStatus(item)
            }
        }

        // ── timeControlStatus ─────────────────────────────────────────────────
        // Read from the observed object directly — change.newValue can return nil
        // for ObjC enum properties in Swift KVO, causing silent guard failures.
        timeControlObservation = player.observe(
            \.timeControlStatus, options: [.new]
        ) { [weak self] observedPlayer, _ in
            guard let self else { return }
            let new = observedPlayer.timeControlStatus
            switch new {
            case .waitingToPlayAtSpecifiedRate:
                self.handleWaiting()
            case .playing:
                if !self.hasFiredFirstFrame {
                    self.handleFirstFrame()
                } else {
                    self.handleCanPlayThrough()
                }
            case .paused:
                break  // handled via rate KVO to avoid spurious events
            @unknown default:
                break
            }
        }

        // ── rate (play / pause) ───────────────────────────────────────────────
        rateObservation = player.observe(\.rate, options: [.new, .old]) {
            [weak self] _, change in
            guard let self else { return }
            let newRate = change.newValue ?? 0
            let oldRate = change.oldValue ?? 0
            guard newRate != oldRate else { return }

            if oldRate == 0 && newRate > 0 {
                self.handlePlay()
            } else if oldRate > 0 && newRate == 0 {
                // Snapshot the playhead immediately on pause so the next periodic
                // observer fire sees diff ≈ 0 and doesn't misfire as a seek.
                let c = CMTimeGetSeconds(player.currentTime())
                self.lastPlayheadMs = UInt64(max(0, c) * 1000)

                // Suppress false pause when the video ends naturally.
                // AVPlayerItemDidPlayToEndTime fires async *after* this KVO, so we
                // check proximity-to-end synchronously here instead.
                let nearEnd: Bool
                if let item = player.currentItem {
                    let d = CMTimeGetSeconds(item.duration)
                    nearEnd = d.isFinite && d > 0 && c >= d - 0.5
                } else {
                    nearEnd = false
                }
                if !nearEnd { self.handlePause() }
            }
        }

        // ── Notifications ─────────────────────────────────────────────────────
        let nc = NotificationCenter.default

        let endedToken = nc.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: nil, queue: .main
        ) { [weak self] notification in
            guard let self,
                  notification.object as AnyObject === self.player.currentItem as AnyObject
            else { return }
            self.handleEnded()
        }
        notificationTokens.append(endedToken)

        let failedToken = nc.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: nil, queue: .main
        ) { [weak self] notification in
            guard let self,
                  notification.object as AnyObject === self.player.currentItem as AnyObject
            else { return }
            let err = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self.handleError(code: "PLAYBACK_FAILED", message: err?.localizedDescription, fatal: true)
        }
        notificationTokens.append(failedToken)

        let qualityToken = nc.addObserver(
            forName: .AVPlayerItemNewAccessLogEntry,
            object: nil, queue: .main
        ) { [weak self] notification in
            guard let self,
                  let item = notification.object as? AVPlayerItem,
                  item === self.player.currentItem,
                  let entry = item.accessLog()?.events.last
            else { return }
            self.handleQualityChange(
                bitrateBps: entry.indicatedBitrate > 0 ? Int(entry.indicatedBitrate) : nil,
                width: nil,
                height: nil
            )
        }
        notificationTokens.append(qualityToken)

        // ── Periodic time observer (playhead + seek detection) ────────────────
        // AVPlayerItem.timeJumpedNotification does not fire for AVPlayerView scrubber
        // seeks on macOS, so seeks are detected here via a small state machine:
        //
        //  • Each tick checks whether the position jumped discontinuously.
        //  • On the first jumping tick: record seekCandidateFromMs (pre-jump position).
        //  • On subsequent jumping ticks: update seekCandidateToMs (drag is still moving).
        //  • On the first *stable* tick after jumps stop: emit ONE seek_start/seek_end pair.
        //
        // This coalesces an entire scrubber drag into a single pair regardless of
        // how many periodic ticks fire during the drag, and works for both directions.
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserverToken = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main
        ) { [weak self] time in
            guard let self, !self.isDestroyed else { return }
            let ms = UInt64(max(0, CMTimeGetSeconds(time)) * 1000)

            if self.hasFiredFirstFrame && !self.isHandlingProgrammaticSeek {
                let rate = player.rate
                let prev = self.lastPlayheadMs

                // A tick is "jumping" if the position moved discontinuously:
                //   • While playing (rate > 0): position decreased OR advanced much
                //     more than one interval (~500 ms at 1×).
                //   • While paused (rate == 0): any change > 200 ms.
                let isJump: Bool
                if rate > 0 {
                    isJump = ms < prev || ms > prev + 250
                } else {
                    let diff = ms > prev ? ms - prev : prev - ms
                    isJump = diff > 250
                }

                if isJump {
                    if !self.seekInProgress {
                        self.seekInProgress = true
                        self.seekCandidateFromMs = prev
                    }
                    self.seekCandidateToMs = ms
                } else if self.seekInProgress {
                    // Position has stabilised — emit the single seek pair.
                    let bufferReady = player.currentItem?.isPlaybackLikelyToKeepUp ?? false
                    self.session?.processEvent(.seekStart(fromMs: self.seekCandidateFromMs))
                    self.session?.processEvent(.seekEnd(toMs: self.seekCandidateToMs, bufferReady: bufferReady))
                    self.seekInProgress = false
                }
            }

            self.lastPlayheadMs = ms
            self.session?.setPlayhead(ms)
        }
    }

    private func observeItemStatus(_ item: AVPlayerItem) {
        itemStatusObservation?.invalidate()
        itemStatusObservation = item.observe(\.status, options: [.new]) {
            [weak self] item, _ in
            guard let self else { return }
            switch item.status {
            case .readyToPlay:
                self.handleCanPlay()
            case .failed:
                self.handleError(
                    code: "ITEM_FAILED",
                    message: item.error?.localizedDescription,
                    fatal: true
                )
            case .unknown:
                break
            @unknown default:
                break
            }
        }
    }

    private func detachObservers() {
        currentItemObservation?.invalidate()
        currentItemObservation = nil
        timeControlObservation?.invalidate()
        timeControlObservation = nil
        rateObservation?.invalidate()
        rateObservation = nil
        itemStatusObservation?.invalidate()
        itemStatusObservation = nil

        for token in notificationTokens {
            NotificationCenter.default.removeObserver(token)
        }
        notificationTokens.removeAll()

        if let token = timeObserverToken {
            player.removeTimeObserver(token)
            timeObserverToken = nil
        }
    }
}

// MARK: - Platform user agent

private func platformUserAgent() -> String {
    #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
    let device = UIDevice.current
    return "\(device.systemName)/\(device.systemVersion)"
    #elseif os(macOS)
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return "macOS/\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    #else
    return "Apple/unknown"
    #endif
}
