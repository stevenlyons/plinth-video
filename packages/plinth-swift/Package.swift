// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PlinthSwift",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "PlinthSwift", targets: ["PlinthSwift"]),
    ],
    targets: [
        // C bridging target — exposes the plinth_core.h header to Swift.
        .systemLibrary(
            name: "PlinthCoreFFI",
            path: "Sources/PlinthCoreFFI"
        ),

        // Swift platform framework.
        .target(
            name: "PlinthSwift",
            dependencies: ["PlinthCoreFFI"],
            linkerSettings: [
                // For local development: link against the Rust debug build.
                // For device/distribution: replace this with the XCFramework binary target.
                .linkedLibrary("plinth_core"),
                .unsafeFlags(["-L../../target/debug"]),
            ]
        ),

        // Unit tests — link against the same Rust debug build.
        .testTarget(
            name: "PlinthSwiftTests",
            dependencies: ["PlinthSwift"],
            linkerSettings: [
                .linkedLibrary("plinth_core"),
                .unsafeFlags(["-L../../target/debug"]),
            ]
        ),
    ]
)
