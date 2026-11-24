import askHost from "./ask-host.md" with { type: "text" };
import askPi from "./ask-pi.md" with { type: "text" };
import cancelPi from "./cancel-pi.md" with { type: "text" };
import checkTestTool from "./check-test-tool.md" with { type: "text" };
import checkTest from "./check-test.md" with { type: "text" };
import piSystem from "./pi-system.md" with { type: "text" };
import replyPi from "./reply-pi.md" with { type: "text" };
import serverInstructions from "./server-instructions.md" with { type: "text" };
import testingQuality from "./testing-quality.md" with { type: "text" };

export const prompts = {
  piSystem: piSystem.trim(),
  askHost: askHost.trim(),
  serverInstructions: serverInstructions.trim(),
  askPi: askPi.trim(),
  replyPi: replyPi.trim(),
  cancelPi: cancelPi.trim(),
  checkTestTool: checkTestTool.trim(),
  checkTest: checkTest.trim(),
  testingQuality: testingQuality.trim(),
};
