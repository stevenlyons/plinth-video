import Foundation

public struct PlinthConfig: Codable {
    public var endpoint: String
    public var projectKey: String
    public var heartbeatIntervalMs: UInt64

    public init(
        endpoint: String = "http://localhost:3000/beacon",
        projectKey: String = "p123456789",
        heartbeatIntervalMs: UInt64 = 10_000
    ) {
        self.endpoint = endpoint
        self.projectKey = projectKey
        self.heartbeatIntervalMs = heartbeatIntervalMs
    }

    public static let `default` = PlinthConfig()

    enum CodingKeys: String, CodingKey {
        case endpoint
        case projectKey = "project_key"
        case heartbeatIntervalMs = "heartbeat_interval_ms"
    }
}
