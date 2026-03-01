// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PlinthAVPlayer",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "PlinthAVPlayer", targets: ["PlinthAVPlayer"]),
    ],
    dependencies: [
        .package(path: "../plinth-apple"),
    ],
    targets: [
        // AVPlayer player integration (Layer 3).
        .target(
            name: "PlinthAVPlayer",
            dependencies: [
                .product(name: "PlinthApple", package: "plinth-apple"),
            ]
        ),

        // AVPlayer integration tests.
        .testTarget(
            name: "PlinthAVPlayerTests",
            dependencies: ["PlinthAVPlayer"],
            linkerSettings: [
                .linkedLibrary("plinth_core"),
                .unsafeFlags(["-L../../../target/debug"]),
            ]
        ),
    ]
)
