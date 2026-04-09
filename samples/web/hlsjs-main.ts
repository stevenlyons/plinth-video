import Hls from "hls.js";
import { PlinthHlsJs, VERSION } from "@wirevice/plinth-hlsjs";
import { VERSION as JS_VERSION } from "@wirevice/plinth-js";
import { setupDemo, showVersions } from "./demo-shell.js";

showVersions({ "plinth-hlsjs": VERSION, "plinth-js": JS_VERSION, "hls.js": Hls.version });

setupDemo(async (url, video, sessionFactory) => {
  if (!Hls.isSupported()) throw new Error("Hls.js not supported in this browser");
  const hls = new Hls();
  const instance = await PlinthHlsJs.initialize(hls, video, { id: url }, { sessionFactory });
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => instance.destroy();
});
