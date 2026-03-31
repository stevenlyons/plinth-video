import Hls from "hls.js";
import { PlinthHlsJs } from "@wirevice/plinth-hlsjs";
import { setupDemo } from "./demo-shell.js";

setupDemo(async (url, video, sessionFactory) => {
  if (!Hls.isSupported()) throw new Error("Hls.js not supported in this browser");
  const hls = new Hls();
  const instance = await PlinthHlsJs.initialize(hls, video, { id: url }, { sessionFactory });
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => instance.destroy();
});
