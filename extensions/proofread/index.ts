import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createProofreadTool } from "./src/proofread-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => createProofreadTool({ config: ctx.config, agentDir: ctx.agentDir }), {
    optional: true,
  });
}
