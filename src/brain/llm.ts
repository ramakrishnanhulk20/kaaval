import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export interface LlmResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  model: string;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_QWEN_BASE_URL = "https://hackathon.bitgetops.com/v1";
const DEFAULT_QWEN_MODEL = "qwen3.8-max";

/** The only part of the Anthropic SDK this module uses, so a test can hand over a fake. */
export interface MessagesApi {
  create(body: Record<string, unknown>): Promise<unknown>;
}

export interface AnthropicClientOptions {
  apiKey?: string;
  model?: string;
  messages?: MessagesApi;
}

/**
 * Claude through the official SDK, version 0.124.0.
 *
 * The system block is sent as one cached text block. Kaaval asks the same rulebook and
 * the same schema on every run of every tick, so runs two and three of an ensemble read
 * almost all of their input from the cache instead of paying for it again.
 *
 * temperature is deliberately not sent. The installed SDK marks it deprecated at
 * node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:3543: "Models released
 * after Claude Opus 4.6 do not support setting temperature... all other values will be
 * rejected with a 400 error." The default model here is newer than that, so the request
 * would fail. Run to run variety comes from the model's own sampling.
 */
export class AnthropicClient implements LlmClient {
  readonly model: string;
  private messages: MessagesApi | null;
  private readonly apiKey: string;

  constructor(opts: AnthropicClientOptions = {}) {
    this.model = opts.model ?? process.env["KAAVAL_CLAUDE_MODEL"] ?? DEFAULT_CLAUDE_MODEL;
    this.messages = opts.messages ?? null;
    this.apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const api = this.api();
    const startedAt = Date.now();
    const raw = (await api.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: req.user }] }],
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
      stop_reason?: string;
    };

    if (raw.stop_reason === "refusal") {
      throw new Error("claude refused the request");
    }

    const usage = raw.usage ?? {};
    return {
      text: (raw.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      promptTokens:
        Number(usage.input_tokens ?? 0) +
        Number(usage.cache_read_input_tokens ?? 0) +
        Number(usage.cache_creation_input_tokens ?? 0),
      completionTokens: Number(usage.output_tokens ?? 0),
      latencyMs: Date.now() - startedAt,
      model: this.model,
    };
  }

  private api(): MessagesApi {
    if (!this.messages) {
      if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      this.messages = new Anthropic({ apiKey: this.apiKey }).messages as unknown as MessagesApi;
    }
    return this.messages;
  }
}

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

type Wire = "chat" | "responses";

/**
 * Which wire shape a base URL answered on, kept for the life of the process so the
 * fallback is paid for once and not on every call of every tick.
 */
const wireByBaseUrl = new Map<string, Wire>();

/**
 * Qwen's long thinking stays off unless QWEN_THINKING=1. Measured through the proxy on
 * 18 September 2026: a one-line prompt took 60 seconds and 2,400 to 3,000 reasoning tokens
 * with it on and 5 seconds with it off, so three sequential runs never fit the 180 seconds
 * a tick allows a brain. Claude is called without extended thinking too, which makes off
 * the like-for-like setting as well.
 */
function qwenThinkingOff(): boolean {
  return process.env["QWEN_THINKING"] !== "1";
}

/**
 * Qwen through Bitget's hackathon proxy, or any OpenAI-shaped endpoint.
 *
 * The proxy's exact wire shape is not documented. The program's own Codex setup page
 * configures it with wire_api = "responses", while the base URL ends in /v1 like a chat
 * completions endpoint, so this client tries chat completions first and falls back to
 * the Responses API once when the endpoint answers 404. Whichever answered is
 * remembered per base URL for the rest of the process.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env["QWEN_BASE_URL"] ?? DEFAULT_QWEN_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.model = opts.model ?? process.env["QWEN_MODEL"] ?? DEFAULT_QWEN_MODEL;
    this.apiKey = opts.apiKey ?? process.env["QWEN_API_KEY"] ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error("QWEN_API_KEY is not set");
    const startedAt = Date.now();
    const known = wireByBaseUrl.get(this.baseUrl);

    if (known !== "responses") {
      const res = await this.post("/chat/completions", this.chatBody(req));
      if (res.status !== 404) {
        wireByBaseUrl.set(this.baseUrl, "chat");
        return this.read(res, startedAt, "chat");
      }
    }

    const res = await this.post("/responses", this.responsesBody(req));
    wireByBaseUrl.set(this.baseUrl, "responses");
    return this.read(res, startedAt, "responses");
  }

  private chatBody(req: LlmRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(qwenThinkingOff() ? { enable_thinking: false } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
  }

  private responsesBody(req: LlmRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_output_tokens: req.maxTokens,
      temperature: req.temperature,
      instructions: req.system,
      input: [{ role: "user", content: req.user }],
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async read(res: Response, startedAt: number, wire: Wire): Promise<LlmResponse> {
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${this.model} answered ${res.status} on the ${wire} shape`);
    }
    const parsed = JSON.parse(raw) as OpenAiPayload;
    const usage = parsed.usage ?? {};
    return {
      text: wire === "chat" ? chatText(parsed) : responsesText(parsed),
      promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
      latencyMs: Date.now() - startedAt,
      model: this.model,
    };
  }
}

interface OpenAiPayload {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

function chatText(payload: OpenAiPayload): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function responsesText(payload: OpenAiPayload): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output ?? [])
    .flatMap((block) => block.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
}
