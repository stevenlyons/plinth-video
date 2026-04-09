import shaka from "shaka-player";
import { PlinthShaka, VERSION } from "@wirevice/plinth-shaka";
import { VERSION as JS_VERSION } from "@wirevice/plinth-js";
import { setupDemo, showVersions } from "./demo-shell.js";

showVersions({ "plinth-shaka": VERSION, "plinth-js": JS_VERSION, "shaka-player": shaka.Player.version });

setupDemo(async (url, video, sessionFactory) => {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error("Shaka Player not supported in this browser");
  const player = new shaka.Player(video);
  const instance = await PlinthShaka.initialize(player, video, { id: url }, { sessionFactory });
  await player.load(url);
  return async () => { instance.destroy(); await player.destroy(); };
});
