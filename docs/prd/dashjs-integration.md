# Feature PRD: dash.js Player Web Integration

## Overview

Add a [dash.js Player](https://dashjs.org/) integration as a new Layer 3 package (`plinth-dashjs`). dash.js is an open-source reference client implementation for the playback of MPEG DASH via Javascript and compliant browsers from the DASH Industry Forum. 

This integration follows the same three-layer architecture and mirrors the `plinth-hlsjs` implementation as closely as dash.js's API allows.


## Goals

- Application developers integrate in a single `await PlinthDashjs.initialize(player, video, videoMeta)` call
- No changes to `plinth-core` or `plinth-js` — Layer 2 is reused as-is
- Event mapping is correct for dash.js's protocol, DASH, which is different from HLS
- Test coverage matches `plinth-hlsjs` (fake player, no real network, no Wasm)
