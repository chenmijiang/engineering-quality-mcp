import { join } from "node:path";

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession as PiAgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentRuntime, AgentSession, HostChannel, OpenSessionOptions } from "@/core/contracts";

import systemPrompt from "./system.md" with { type: "text" };

export interface PiRuntimeOptions {
  /** Directory whose Pi settings seed every session. */
  cwd: string;
  agentDir: string;
  model?: { provider: string; id: string };
}

// No automatic resource discovery: importing user extensions could enable arbitrary tools.
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt.trim(),
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const questionSchema = Type.Object({ question: Type.String({ minLength: 1, maxLength: 16_000 }) });

function askHostTool(host: HostChannel): ToolDefinition<typeof questionSchema> {
  return {
    name: "ask_host",
    label: "Ask host",
    parameters: questionSchema,
    description:
      "Ask the calling host agent for missing information or a user decision. Waits for the host's answer, then resumes your current run. Ask one concrete question; never request nested delegation.",
    promptSnippet: "Ask the host a necessary clarification and wait for its answer.",
    executionMode: "sequential",
    async execute(_id, { question }, signal) {
      const answer = await host.ask(question, signal);
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  };
}

class PiSession implements AgentSession {
  #turnError: string | undefined;

  constructor(private readonly session: PiAgentSession) {
    // Some provider errors end the stream normally rather than rejecting prompt().
    session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted")
      ) {
        this.#turnError = event.message.errorMessage ?? `Pi ${event.message.stopReason}`;
      }
    });
  }

  get model() {
    const model = this.session.model;
    return model ? `${model.provider}/${model.id}` : undefined;
  }

  async prompt(text: string) {
    this.#turnError = undefined;
    await this.session.prompt(text, { expandPromptTemplates: false });
    if (this.#turnError) throw new Error(this.#turnError);
    return this.session.getLastAssistantText() ?? "";
  }

  dispose() {
    this.session.dispose();
  }
}

/** Pi SDK backend: read-only file tools plus `ask_host`, with no resource discovery or persistence. */
export class PiRuntime implements AgentRuntime {
  // The SDK does not export its `Settings` type.
  readonly #baseSettings: ReturnType<SettingsManager["getSettings"]>;
  #modelRuntime: Promise<ModelRuntime> | undefined;

  constructor(private readonly options: PiRuntimeOptions) {
    // Copy existing settings into a non-persisting manager: SDK changes cannot rewrite settings.
    this.#baseSettings = SettingsManager.create(options.cwd, options.agentDir).getSettings();
  }

  async open({ cwd, host }: OpenSessionOptions): Promise<AgentSession> {
    const modelRuntime = await this.#getModelRuntime();
    const { model: wanted, agentDir } = this.options;
    const model = wanted ? modelRuntime.getModel(wanted.provider, wanted.id) : undefined;
    if (wanted && !model) throw new Error(`Unknown Pi model: ${wanted.provider}/${wanted.id}`);
    const base = this.#baseSettings;
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      tools: ["ask_host", "read", "grep", "find", "ls"],
      customTools: [askHostTool(host)],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        ...base,
        compaction: { ...base.compaction, enabled: false },
        retry: { ...base.retry, enabled: false },
        cacheWarming: "off",
      }),
    });
    return new PiSession(session);
  }

  async shutdown() {
    if (this.#modelRuntime) await (await this.#modelRuntime).settleCredentialWrites();
  }

  #getModelRuntime() {
    return (this.#modelRuntime ??= ModelRuntime.create({
      authPath: join(this.options.agentDir, "auth.json"),
      modelsPath: join(this.options.agentDir, "models.json"),
    }).catch((error: unknown) => {
      this.#modelRuntime = undefined;
      throw error;
    }));
  }
}
