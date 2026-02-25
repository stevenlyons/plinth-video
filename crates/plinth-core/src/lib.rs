pub mod beacon;
pub mod config;
pub mod event;
pub mod metrics;
pub mod session;
pub mod state;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;

// Convenient re-exports for the most common public types.
pub use beacon::{
    Beacon, BeaconBatch, BeaconEvent, ClientMetadata, PlayerError, QualityLevel, SdkComponent,
    SdkMetadata, VideoMetadata,
};
pub use config::Config;
pub use event::PlayerEvent;
pub use metrics::Metrics;
pub use session::{Session, SessionMeta};
pub use state::PlayerState;
