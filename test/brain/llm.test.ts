// The two model clients. The OpenAI-shaped one runs against a real HTTP server started
// in the test, including the 404 fallback from chat completions to the Responses API; the
// Anthropic one runs against a fake messages API. Does NOT cover: the real Anthropic
// endpoint or Bitget's real Qwen proxy (no key in CI), streaming, or retries, which the
// ensemble handles by counting a failed run as invalid.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicClient, OpenAiCompatibleClient } from "../../src/brain/llm.js";

interface Recorded {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ baseUrl: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

const chatPayload = {
  choices: [{ message: { content: '{"summary":"flat","targets":[]}' } }],
  usage: { prompt_tokens: 1_200, completion_tokens: 90 },
};

const responsesPayload = {
  output_text: '{"summary":"flat","targets":[]}',
  usage: { input_tokens: 1_100, output_tokens: 80 },
};

const REQUEST = { system: "the rulebook", user: "the world", maxTokens: 500, temperature: 0.7 };

describe("OpenAiCompatibleClient", () => {
  it("posts an OpenAI chat completion and reads the reply", async () => {
    const { baseUrl, seen } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatPayload));
    });
    const client = new OpenAiCompatibleClient({ baseUrl, apiKey: "test-key", model: "qwen3.8-max" });

    const res = await client.complete(REQUEST);

    expect(res.text).toBe('{"summary":"flat","targets":[]}');
    expect(res.promptTokens).toBe(1_200);
    expect(res.completionTokens).toBe(90);
    expect(res.model).toBe("qwen3.8-max");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]?.path).toBe("/v1/chat/completions");
    expect(seen[0]?.auth).toBe("Bearer test-key");
    expect(seen[0]?.body["model"]).toBe("qwen3.8-max");
    expect(seen[0]?.body["temperature"]).toBe(0.7);
    expect(seen[0]?.body["messages"]).toEqual([
      { role: "system", content: "the rulebook" },
      { role: "user", content: "the world" },
    ]);
  });

  it("asks Qwen not to think unless QWEN_THINKING is 1, because a thinking call misses the tick", async () => {
    const { baseUrl, seen } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatPayload));
    });
    const client = new OpenAiCompatibleClient({ baseUrl, apiKey: "test-key" });
    const before = process.env["QWEN_THINKING"];

    try {
      delete process.env["QWEN_THINKING"];
      await client.complete(REQUEST);
      process.env["QWEN_THINKING"] = "1";
      await client.complete(REQUEST);
    } finally {
      if (before === undefined) delete process.env["QWEN_THINKING"];
      else process.env["QWEN_THINKING"] = before;
    }

    expect(seen[0]?.body["enable_thinking"]).toBe(false);
    expect(seen[1]?.body).not.toHaveProperty("enable_thinking");
  });

  it("falls back to the Responses API when chat completions is not there", async () => {
    const { baseUrl, seen } = await startServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responsesPayload));
    });
    const client = new OpenAiCompatibleClient({ baseUrl, apiKey: "test-key" });

    const first = await client.complete(REQUEST);
    const second = await client.complete(REQUEST);

    expect(first.text).toBe('{"summary":"flat","targets":[]}');
    expect(first.promptTokens).toBe(1_100);
    expect(second.text).toBe('{"summary":"flat","targets":[]}');
    expect(seen.map((s) => s.path)).toEqual([
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/responses",
    ]);
    expect(seen[1]?.body["instructions"]).toBe("the rulebook");
    expect(seen[1]?.body["input"]).toEqual([{ role: "user", content: "the world" }]);
    expect(seen[1]?.body["max_output_tokens"]).toBe(500);
  });

  it("reads the Responses API block form as well as output_text", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: '{"targets":[]}' }] }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    });
    const client = new OpenAiCompatibleClient({ baseUrl, apiKey: "test-key" });

    expect((await client.complete(REQUEST)).text).toBe('{"targets":[]}');
  });

  it("throws when the endpoint refuses, so the ensemble can count the run as invalid", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream is down" }));
    });
    const client = new OpenAiCompatibleClient({ baseUrl, apiKey: "test-key" });

    await expect(client.complete(REQUEST)).rejects.toThrow("answered 500");
  });

  it("throws before making a call when there is no key", async () => {
    const client = new OpenAiCompatibleClient({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "" });

    await expect(client.complete(REQUEST)).rejects.toThrow("QWEN_API_KEY is not set");
  });

  it("defaults to Bitget's hackathon proxy and the sponsor's model", () => {
    const client = new OpenAiCompatibleClient({ apiKey: "test-key" });

    expect(client.model).toBe("qwen3.8-max");
  });
});

describe("AnthropicClient", () => {
  it("sends the system turn as one cached block and no temperature", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new AnthropicClient({
      model: "claude-sonnet-5",
      messages: {
        async create(body) {
          bodies.push(body);
          return {
            content: [{ type: "text", text: '{"summary":"flat","targets":[]}' }],
            usage: {
              input_tokens: 200,
              cache_read_input_tokens: 1_000,
              cache_creation_input_tokens: 50,
              output_tokens: 70,
            },
          };
        },
      },
    });

    const res = await client.complete(REQUEST);

    expect(res.text).toBe('{"summary":"flat","targets":[]}');
    expect(res.promptTokens).toBe(1_250);
    expect(res.completionTokens).toBe(70);
    expect(res.model).toBe("claude-sonnet-5");
    expect(bodies[0]?.["system"]).toEqual([
      { type: "text", text: "the rulebook", cache_control: { type: "ephemeral" } },
    ]);
    expect(bodies[0]?.["max_tokens"]).toBe(500);
    expect("temperature" in (bodies[0] ?? {})).toBe(false);
  });

  it("keeps only the text blocks of a reply", async () => {
    const client = new AnthropicClient({
      messages: {
        async create() {
          return {
            content: [
              { type: "thinking", thinking: "working it out" },
              { type: "text", text: "the answer" },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    });

    expect((await client.complete(REQUEST)).text).toBe("the answer");
  });

  it("throws on a refusal rather than returning an empty decision", async () => {
    const client = new AnthropicClient({
      messages: {
        async create() {
          return { stop_reason: "refusal", content: [], usage: {} };
        },
      },
    });

    await expect(client.complete(REQUEST)).rejects.toThrow("refused");
  });

  it("throws when there is no key and no injected client", async () => {
    const client = new AnthropicClient({ apiKey: "" });

    await expect(client.complete(REQUEST)).rejects.toThrow("ANTHROPIC_API_KEY is not set");
  });
});
