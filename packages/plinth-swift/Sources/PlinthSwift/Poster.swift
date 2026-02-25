import Foundation

/// Default beacon poster — spawns a fire-and-forget Task for each batch.
/// The synchronous `(BeaconBatch) -> Void` contract lets callers (including tests)
/// capture beacons without async concerns; the async HTTP work stays internal.
public func defaultBeaconPoster(endpoint: String, projectKey: String) -> (BeaconBatch) -> Void {
    return { batch in
        Task {
            guard let url = URL(string: endpoint) else { return }
            guard let body = try? JSONEncoder().encode(batch) else { return }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(projectKey, forHTTPHeaderField: "X-Project-Key")

            _ = try? await URLSession.shared.data(for: request)
        }
    }
}

// Make BeaconBatch encodable for the HTTP body.
extension BeaconBatch: Encodable {
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(beacons, forKey: .beacons)
    }

    enum CodingKeys: String, CodingKey {
        case beacons
    }
}

extension Beacon: Encodable {
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seq, forKey: .seq)
        try container.encode(playId, forKey: .playId)
        try container.encode(ts, forKey: .ts)
        try container.encode(event, forKey: .event)
    }
}
