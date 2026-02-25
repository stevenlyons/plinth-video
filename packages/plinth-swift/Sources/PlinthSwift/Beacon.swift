import Foundation

/// Minimal decodable representation of a beacon batch returned by the core.
/// Only the fields needed by the platform layer are mapped.
public struct BeaconBatch: Decodable {
    public let beacons: [Beacon]
}

public struct Beacon: Decodable {
    public let seq: UInt32
    public let playId: String
    public let ts: UInt64
    public let event: String

    enum CodingKeys: String, CodingKey {
        case seq
        case playId = "play_id"
        case ts, event
    }
}
