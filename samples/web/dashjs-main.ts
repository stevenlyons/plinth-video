import dashjs, { MediaPlayer } from "dashjs";
import { PlinthDashjs, VERSION } from "@wirevice/plinth-dashjs";
import { VERSION as JS_VERSION } from "@wirevice/plinth-js";
import { setupDemo, showVersions } from "./demo-shell.js";

showVersions({ "plinth-dashjs": VERSION, "plinth-js": JS_VERSION, "dash.js": dashjs.Version() });

setupDemo(async (url, video, sessionFactory) => {
  const player = MediaPlayer().create();
  const instance = await PlinthDashjs.initialize(player as any, video, { id: url }, { sessionFactory });
  player.initialize(video, url, false);
  return () => { instance.destroy(); player.reset(); };
});
