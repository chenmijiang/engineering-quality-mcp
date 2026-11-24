import askHost from "./ask-host.md" with { type: "text" };
import askPi from "./ask-pi.md" with { type: "text" };
import cancelPi from "./cancel-pi.md" with { type: "text" };
import piSystem from "./pi-system.md" with { type: "text" };
import replyPi from "./reply-pi.md" with { type: "text" };
import serverInstructions from "./server-instructions.md" with { type: "text" };

export const prompts = {
  piSystem: piSystem.trim(),
  askHost: askHost.trim(),
  serverInstructions: serverInstructions.trim(),
  askPi: askPi.trim(),
  replyPi: replyPi.trim(),
  cancelPi: cancelPi.trim(),
};
