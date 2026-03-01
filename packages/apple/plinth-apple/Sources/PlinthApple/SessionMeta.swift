import Foundation

public struct SessionMeta: Codable {
    public var video: VideoMetadata
    public var client: ClientMetadata
    public var sdk: SdkMetadata

    public init(video: VideoMetadata, client: ClientMetadata, sdk: SdkMetadata) {
        self.video = video
        self.client = client
        self.sdk = sdk
    }
}

public struct VideoMetadata: Codable {
    public var id: String
    public var title: String?

    public init(id: String, title: String? = nil) {
        self.id = id
        self.title = title
    }
}

public struct ClientMetadata: Codable {
    public var userAgent: String

    public init(userAgent: String) {
        self.userAgent = userAgent
    }

    enum CodingKeys: String, CodingKey {
        case userAgent = "user_agent"
    }
}

public struct SdkMetadata: Codable {
    public var apiVersion: Int
    public var core: SdkComponent
    public var framework: SdkComponent
    public var player: SdkComponent

    public init(apiVersion: Int, core: SdkComponent, framework: SdkComponent, player: SdkComponent) {
        self.apiVersion = apiVersion
        self.core = core
        self.framework = framework
        self.player = player
    }

    enum CodingKeys: String, CodingKey {
        case apiVersion = "api_version"
        case core, framework, player
    }
}

public struct SdkComponent: Codable {
    public var name: String
    public var version: String

    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }
}
