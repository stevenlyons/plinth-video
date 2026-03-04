import Foundation
import PlinthCoreFFI

/// Platform framework for plinth-video on Apple platforms.
///
/// Wraps the Rust core via C FFI, drives a repeating timer for heartbeats,
/// and posts beacon batches via an injected async handler.
///
/// Usage:
/// ```swift
/// let session = PlinthSession.create(meta: meta)
/// session.processEvent(.load(src: url))
/// // ...
/// session.destroy()
/// ```
public final class PlinthSession {

    // MARK: - Private state

    private let ptr: OpaquePointer
    private let config: PlinthConfig
    private let beaconHandler: (BeaconBatch) -> Void
    private var timerSource: DispatchSourceTimer?
    private var isDestroyed = false

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    // MARK: - Factory

    /// Create a new session and start the heartbeat timer.
    ///
    /// - Parameters:
    ///   - meta:           Session metadata (video, client, SDK identifiers).
    ///   - config:         Optional config; defaults to localhost:3000 / p123456789.
    ///   - beaconHandler:  Called synchronously with each beacon batch.
    ///                     Defaults to a fire-and-forget URLSession POST.
    ///                     Inject a closure in tests to capture beacons without HTTP.
    /// - Returns: A ready `PlinthSession`, or `nil` if JSON encoding fails.
    public static func create(
        meta: SessionMeta,
        config: PlinthConfig = .default,
        beaconHandler: ((BeaconBatch) -> Void)? = nil
    ) -> PlinthSession? {
        let poster = beaconHandler ?? defaultBeaconPoster(endpoint: config.endpoint, projectKey: config.projectKey)

        guard
            let configData = try? encoder.encode(config),
            let metaData = try? encoder.encode(meta),
            let configStr = String(data: configData, encoding: .utf8),
            let metaStr = String(data: metaData, encoding: .utf8)
        else { return nil }

        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        guard let ptr = plinth_session_new(configStr, metaStr, now) else { return nil }

        return PlinthSession(ptr: ptr, config: config, beaconHandler: poster)
    }

    private init(
        ptr: OpaquePointer,
        config: PlinthConfig,
        beaconHandler: @escaping (BeaconBatch) -> Void
    ) {
        self.ptr = ptr
        self.config = config
        self.beaconHandler = beaconHandler
        startHeartbeat()
    }

    deinit {
        if !isDestroyed { destroy() }
    }

    // MARK: - Public API

    /// Send a player event to the state machine. Posts any resulting beacons.
    public func processEvent(_ event: PlayerEvent) {
        guard !isDestroyed else { return }
        guard
            let data = try? Self.encoder.encode(event),
            let json = String(data: data, encoding: .utf8)
        else { return }

        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        guard let raw = plinth_session_process_event(ptr, json, now) else { return }
        let result = String(cString: raw)
        plinth_free_string(raw)
        emit(result)
    }

    /// Update the platform-reported playhead position (used in heartbeat beacons).
    public func setPlayhead(_ ms: UInt64) {
        guard !isDestroyed else { return }
        plinth_session_set_playhead(ptr, ms)
    }

    /// Return the last playhead position reported by the platform, in milliseconds.
    public func getPlayhead() -> UInt64 {
        guard !isDestroyed else { return 0 }
        return plinth_session_get_playhead(ptr)
    }

    /// Tear down the session. Stops the timer, posts any final beacons, frees memory.
    /// Idempotent — safe to call more than once.
    public func destroy() {
        guard !isDestroyed else { return }
        isDestroyed = true
        stopHeartbeat()

        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        guard let raw = plinth_session_destroy(ptr, now) else { return }
        let result = String(cString: raw)
        plinth_free_string(raw)
        emit(result)
    }

    // MARK: - Private helpers

    /// Parse a beacon-batch JSON string and call `beaconHandler` if non-empty.
    private func emit(_ batchJson: String) {
        guard
            let data = batchJson.data(using: .utf8),
            let batch = try? Self.decoder.decode(BeaconBatch.self, from: data),
            !batch.beacons.isEmpty
        else { return }

        beaconHandler(batch)
    }

    private func startHeartbeat() {
        let source = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let interval = DispatchTimeInterval.milliseconds(Int(config.heartbeatIntervalMs))
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in self?.tick() }
        source.resume()
        timerSource = source
    }

    private func stopHeartbeat() {
        timerSource?.cancel()
        timerSource = nil
    }

    private func tick() {
        guard !isDestroyed else { return }
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        guard let raw = plinth_session_tick(ptr, now) else { return }
        let result = String(cString: raw)
        plinth_free_string(raw)
        emit(result)
    }
}
