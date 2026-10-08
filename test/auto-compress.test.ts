import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RawObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "ses_test",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "file contents here",
    },
    ...overrides,
  };
}

describe("mem::observe auto-compress gate (#138)", () => {
  beforeEach(() => {
    // Reset module cache so observe.js re-imports config.js with the
    // fresh AGENTMEMORY_AUTO_COMPRESS env state. Without this, a later
    // test that sets the env var can be undermined by cached module
    // state from an earlier test (and vice versa).
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("default (AGENTMEMORY_AUTO_COMPRESS unset): does NOT fire mem::compress", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger(
      "mem::observe",
      validPayload(),
    )) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });

  it("default: stores a synthetic CompressedObservation with the raw-derived fields", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const payload = validPayload();
    await sdk.trigger("mem::observe", payload);

    const scope = `mem:obs:${payload.sessionId}`;
    const stored = kv.store.get(scope);
    expect(stored).toBeDefined();
    expect(stored!.size).toBe(1);
    const [entry] = Array.from(stored!.values());
    const obs = entry as {
      type: string;
      title: string;
      files: string[];
      confidence: number;
    };
    expect(obs.type).toBe("file_read");
    expect(obs.title).toBe("Read");
    expect(obs.files).toContain("src/foo.ts");
    expect(obs.confidence).toBe(0.3);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: fires mem::compress exactly once", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger(
      "mem::observe",
      validPayload({
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
          tool_output: "ok",
        },
      }),
    );

    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(1);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: a read-only call stays synthetic", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const { observationId } = (await sdk.trigger("mem::observe", validPayload())) as {
      observationId: string;
    };

    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
    const obs = await kv.get<{ confidence?: number }>(`mem:obs:ses_test`, observationId);
    expect(obs?.confidence).toBe(0.3);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: a hook with no tool payload stays synthetic (#1270)", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const { observationId } = (await sdk.trigger(
      "mem::observe",
      validPayload({ hookType: "post_tool_use", data: { tool_name: "Stop", tool_input: {} } }),
    )) as { observationId: string };

    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
    const obs = await kv.get<{ narrative?: string }>(`mem:obs:ses_test`, observationId);
    expect(typeof obs?.narrative).toBe("string");
  });

  it("AGENTMEMORY_AUTO_COMPRESS=false explicitly: does NOT fire mem::compress", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });
});

describe("buildSyntheticCompression hook payloads", () => {
  const base = {
    id: "obs_h",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
  };

  it("titles a prompt from its text, not the hook name", async () => {
    const { buildSyntheticCompression } = await import("../src/functions/compress-synthetic.js");
    const synth = buildSyntheticCompression({
      ...base,
      hookType: "prompt_submit",
      userPrompt: "  Fix the   flaky\nretry test in observe.ts  ",
      raw: {},
    });
    expect(synth.title).toBe("Fix the flaky retry test in observe.ts");
    expect(synth.narrative).toContain("flaky");
    const long = buildSyntheticCompression({
      ...base,
      hookType: "prompt_submit",
      userPrompt: "word ".repeat(100),
      raw: {},
    });
    expect(long.title.length).toBeLessThanOrEqual(80);
  });

  it("extracts title and narrative from subagent, task and notification payloads", async () => {
    const { buildSyntheticCompression } = await import("../src/functions/compress-synthetic.js");
    const start = buildSyntheticCompression({
      ...base,
      hookType: "subagent_start",
      raw: { agent_id: "a1", agent_type: "Explore" },
    });
    expect(start.type).toBe("subagent");
    expect(start.title).toBe("Subagent started: Explore");
    expect(start.narrative).toContain("a1");

    const stop = buildSyntheticCompression({
      ...base,
      hookType: "subagent_stop",
      raw: { agent_id: "a1", agent_type: "Explore", last_message: "Found three callers." },
    });
    expect(stop.title).toBe("Subagent finished: Explore");
    expect(stop.narrative).toContain("Found three callers.");

    const task = buildSyntheticCompression({
      ...base,
      hookType: "task_completed",
      raw: { task_id: "7", task_subject: "Add retry", task_description: "Retry on ENOSPC", team_name: "core" },
    });
    expect(task.type).toBe("subagent");
    expect(task.title).toBe("Task completed: Add retry");
    expect(task.narrative).toContain("Retry on ENOSPC");

    const note = buildSyntheticCompression({
      ...base,
      hookType: "notification",
      raw: { notification_type: "permission_prompt", title: "Permission needed", message: "Claude wants to run rm" },
    });
    expect(note.type).toBe("notification");
    expect(note.title).toBe("Permission needed");
    expect(note.narrative).toContain("Claude wants to run rm");
  });

  it("titles a tool failure with the tool and keeps the error in the narrative", async () => {
    const { buildSyntheticCompression } = await import("../src/functions/compress-synthetic.js");
    const synth = buildSyntheticCompression({
      ...base,
      hookType: "post_tool_failure",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "exit 1",
      raw: {},
    });
    expect(synth.type).toBe("error");
    expect(synth.title).toBe("Bash failed");
    expect(synth.narrative).toContain("exit 1");
  });
});

describe("buildSyntheticCompression", () => {
  it("maps common tool names to the right ObservationType", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const base: RawObservation = {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      raw: {},
    };
    const cases: Array<[string, string]> = [
      ["Read", "file_read"],
      ["Write", "file_write"],
      ["Edit", "file_edit"],
      ["Bash", "command_run"],
      ["Grep", "search"],
      ["WebFetch", "web_fetch"],
      ["Task", "subagent"],
      ["UnknownTool", "other"],
      ["Agent", "subagent"],
      ["TaskStop", "subagent"],
      ["TaskUpdate", "subagent"],
      ["SendMessage", "subagent"],
      ["ListAgents", "subagent"],
      ["AskUserQuestion", "decision"],
      ["Skill", "other"],
      ["ToolSearch", "other"],
      ["mcp__claude-in-chrome__read_console_messages", "web_fetch"],
      ["mcp__claude-in-chrome__javascript_tool", "web_fetch"],
      ["mcp__claude-in-chrome__navigate", "web_fetch"],
    ];
    for (const [name, expectedType] of cases) {
      const synthetic = (
        await import("../src/functions/compress-synthetic.js")
      ).buildSyntheticCompression({ ...base, toolName: name });
      expect(synthetic.type, `${name} -> ${expectedType}`).toBe(expectedType);
    }
    // silence unused warning — buildSyntheticCompression is used above
    expect(typeof buildSyntheticCompression).toBe("function");
  });

  it("extracts file paths from tool_input into the files array", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const synth = buildSyntheticCompression({
      id: "obs_2",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: { file_path: "/app/src/bar.ts", pattern: "foo" },
      raw: {},
    });
    expect(synth.files).toContain("/app/src/bar.ts");
    expect(synth.files).toContain("foo");
    expect(synth.type).toBe("file_edit");
  });

  it("truncates long narratives so it can't blow up the index", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const longInput = "x".repeat(2000);
    const synth = buildSyntheticCompression({
      id: "obs_3",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: longInput },
      toolOutput: longInput,
      raw: {},
    });
    // 2000-char budget (middle-out) + the "[...N chars omitted...]" marker.
    expect(synth.narrative.length).toBeLessThanOrEqual(2100);
  });

  it("maps post_tool_failure to the error type even with no tool name", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const synth = buildSyntheticCompression({
      id: "obs_4",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_failure",
      raw: {},
    });
    expect(synth.type).toBe("error");
  });

  it("types subagent hooks as subagent work", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    for (const hookType of ["subagent_start", "subagent_stop", "task_completed"] as const) {
      const synth = buildSyntheticCompression({
        id: "obs_6",
        sessionId: "ses_1",
        timestamp: new Date().toISOString(),
        hookType,
        raw: {},
      });
      expect(synth.type, hookType).toBe("subagent");
    }
  });

  // The 15 Observations of the 30-Observation benchmark sample (#90) whose
  // synthetic type disagreed with cybertiel's. `expected` is the type the table
  // should give; where it differs from `reference`, cybertiel is overruled (a
  // Bash command is command_run whatever it did, identical Agent spawns share
  // one type, every claude-in-chrome tool is web_fetch, a task-notification
  // prompt is still a prompt).
  it("types the 15 benchmark-sample mismatches (#90)", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const mismatches: Array<{
      id: string;
      hookType: RawObservation["hookType"];
      toolName?: string;
      reference: string;
      expected: string;
    }> = [
      { id: "obs_mupyc9ak", hookType: "post_tool_use", toolName: "Bash", reference: "file_edit", expected: "command_run" },
      { id: "obs_mupzimrc", hookType: "post_tool_use", toolName: "Bash", reference: "command_run", expected: "command_run" },
      { id: "obs_murbjjlf", hookType: "post_tool_use", toolName: "Bash", reference: "file_edit", expected: "command_run" },
      { id: "obs_muqxdrcx", hookType: "post_tool_use", toolName: "Bash", reference: "search", expected: "command_run" },
      { id: "obs_muprzskn", hookType: "post_tool_use", toolName: "Agent", reference: "task", expected: "subagent" },
      { id: "obs_mupp1bjb", hookType: "post_tool_use", toolName: "AskUserQuestion", reference: "conversation", expected: "decision" },
      { id: "obs_mupf85sa", hookType: "post_tool_use", toolName: "AskUserQuestion", reference: "decision", expected: "decision" },
      { id: "obs_murbm320", hookType: "post_tool_use", toolName: "SendMessage", reference: "notification", expected: "subagent" },
      { id: "obs_mur1fteg", hookType: "post_tool_use", toolName: "SendMessage", reference: "notification", expected: "subagent" },
      { id: "obs_mupox0z8", hookType: "prompt_submit", reference: "subagent", expected: "conversation" },
      { id: "obs_muqy52h3", hookType: "post_tool_use", toolName: "mcp__claude-in-chrome__read_console_messages", reference: "discovery", expected: "web_fetch" },
      { id: "obs_muqy2y9s", hookType: "post_tool_use", toolName: "mcp__claude-in-chrome__javascript_tool", reference: "web_fetch", expected: "web_fetch" },
      { id: "obs_mur6x7se", hookType: "post_tool_use", toolName: "mcp__claude-in-chrome__navigate", reference: "command_run", expected: "web_fetch" },
      { id: "obs_mupo7tgw", hookType: "post_tool_use", toolName: "ListAgents", reference: "discovery", expected: "subagent" },
      { id: "obs_mur1x14c", hookType: "post_tool_use", toolName: "TaskStop", reference: "task", expected: "subagent" },
    ];
    expect(mismatches).toHaveLength(15);
    for (const { id, hookType, toolName, expected } of mismatches) {
      const synth = buildSyntheticCompression({
        id,
        sessionId: "ses_1",
        timestamp: new Date().toISOString(),
        hookType,
        toolName,
        raw: {},
      });
      expect(synth.type, `${id} ${toolName ?? hookType}`).toBe(expected);
    }
  });

  it("keeps the hook type ahead of the tool-name table", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const synth = buildSyntheticCompression({
      id: "obs_5",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_failure",
      toolName: "AskUserQuestion",
      raw: {},
    });
    expect(synth.type).toBe("error");
  });
});
