/**
 * OpenAI Chat Completions 的最小兼容类型。
 *
 * 只覆盖 mock 需要读写的子集：请求侧读 stream / stream_options / model，
 * 响应侧构造完整的 chat.completion 与 chat.completion.chunk。
 */

export type FinishReason =
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | "function_call";

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export interface AssistantMessage {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
}

export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface ChatCompletion {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: {
        index: number;
        message: AssistantMessage;
        finish_reason: FinishReason;
        logprobs: null;
    }[];
    usage: Usage;
}

/** 流式 delta：首包带 role，content / tool_calls 按片推送，末包 delta 为空。 */
export interface ChunkDelta {
    role?: "assistant";
    content?: string;
    tool_calls?: {
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
    }[];
}

export interface ChatCompletionChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: {
        index: number;
        delta: ChunkDelta;
        finish_reason: FinishReason | null;
        logprobs?: null;
    }[];
    usage?: Usage | null;
}

export interface ChatCompletionRequest {
    model?: string;
    messages?: unknown[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean } | null;
    [key: string]: unknown;
}

/** OpenAI 风格的错误体，保证客户端能用统一路径解析失败。 */
export interface ErrorBody {
    error: {
        message: string;
        type: string;
        code: string | null;
    };
}
