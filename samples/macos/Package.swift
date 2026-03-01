// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacosDemo",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../packages/apple/plinth-avplayer"),
    ],
    targets: [
        .executableTarget(
            name: "MacosDemo",
            dependencies: [
                .product(name: "PlinthAVPlayer", package: "plinth-avplayer"),
            ],
            path: "Sources/MacosDemo",
            linkerSettings: [
                .linkedLibrary("plinth_core"),
                .unsafeFlags(["-L../../target/debug"]),
            ]
        ),
    ]
)
