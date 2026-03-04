#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

use crate::{
    beacon::BeaconBatch,
    config::Config,
    event::PlayerEvent,
    session::{Session, SessionMeta},
};

#[wasm_bindgen]
pub struct WasmSession {
    inner: Session,
}

#[wasm_bindgen]
impl WasmSession {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, meta_json: &str, now_ms: f64) -> Result<WasmSession, JsValue> {
        let config: Config = miniserde::json::from_str(config_json)
            .map_err(|_| JsValue::from_str("config parse error"))?;
        let meta: SessionMeta = miniserde::json::from_str(meta_json)
            .map_err(|_| JsValue::from_str("meta parse error"))?;
        Ok(WasmSession {
            inner: Session::new(config, meta, now_ms as u64),
        })
    }

    pub fn process_event(&mut self, event_json: &str, now_ms: f64) -> Result<String, JsValue> {
        let event: PlayerEvent = miniserde::json::from_str(event_json)
            .map_err(|_| JsValue::from_str("event parse error"))?;
        let beacons = self.inner.process_event(event, now_ms as u64);
        Ok(miniserde::json::to_string(&BeaconBatch::new(beacons)))
    }

    pub fn tick(&mut self, now_ms: f64) -> Result<String, JsValue> {
        let beacons = self.inner.tick(now_ms as u64);
        Ok(miniserde::json::to_string(&BeaconBatch::new(beacons)))
    }

    pub fn destroy(&mut self, now_ms: f64) -> Result<String, JsValue> {
        let beacons = self.inner.destroy(now_ms as u64);
        Ok(miniserde::json::to_string(&BeaconBatch::new(beacons)))
    }

    pub fn set_playhead(&mut self, playhead_ms: f64) {
        self.inner.set_playhead(playhead_ms as u64);
    }

    pub fn get_playhead(&self) -> f64 {
        self.inner.get_playhead() as f64
    }
}
