import Foundation

/// All player inputs that the session state machine can act on.
/// Mirrors the Rust `PlayerEvent` enum — serialized as `{"type":"snake_case",...}`.
public enum PlayerEvent: Encodable {
    case load(src: String)
    case canPlay
    case play
    case waiting
    case firstFrame
    case canPlayThrough
    case pause
    case seekStart(fromMs: UInt64)
    case seekEnd(toMs: UInt64, bufferReady: Bool)
    case ended
    case error(code: String, message: String?, fatal: Bool)
    case destroy
    case qualityChange(quality: QualityLevel)

    private enum CodingKeys: String, CodingKey {
        case type
        case src
        case fromMs = "from_ms"
        case toMs = "to_ms"
        case bufferReady = "buffer_ready"
        case code, message, fatal, quality
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .load(let src):
            try container.encode("load", forKey: .type)
            try container.encode(src, forKey: .src)
        case .canPlay:
            try container.encode("can_play", forKey: .type)
        case .play:
            try container.encode("play", forKey: .type)
        case .waiting:
            try container.encode("waiting", forKey: .type)
        case .firstFrame:
            try container.encode("first_frame", forKey: .type)
        case .canPlayThrough:
            try container.encode("can_play_through", forKey: .type)
        case .pause:
            try container.encode("pause", forKey: .type)
        case .seekStart(let fromMs):
            try container.encode("seek_start", forKey: .type)
            try container.encode(fromMs, forKey: .fromMs)
        case .seekEnd(let toMs, let bufferReady):
            try container.encode("seek_end", forKey: .type)
            try container.encode(toMs, forKey: .toMs)
            try container.encode(bufferReady, forKey: .bufferReady)
        case .ended:
            try container.encode("ended", forKey: .type)
        case .error(let code, let message, let fatal):
            try container.encode("error", forKey: .type)
            try container.encode(code, forKey: .code)
            if let message {
                try container.encode(message, forKey: .message)
            }
            try container.encode(fatal, forKey: .fatal)
        case .destroy:
            try container.encode("destroy", forKey: .type)
        case .qualityChange(let quality):
            try container.encode("quality_change", forKey: .type)
            try container.encode(quality, forKey: .quality)
        }
    }
}

public struct QualityLevel: Codable {
    public var bitrateBps: Int?
    public var width: Int?
    public var height: Int?
    public var framerate: String?
    public var codec: String?

    public init(
        bitrateBps: Int? = nil,
        width: Int? = nil,
        height: Int? = nil,
        framerate: String? = nil,
        codec: String? = nil
    ) {
        self.bitrateBps = bitrateBps
        self.width = width
        self.height = height
        self.framerate = framerate
        self.codec = codec
    }

    enum CodingKeys: String, CodingKey {
        case bitrateBps = "bitrate_bps"
        case width, height, framerate, codec
    }
}
