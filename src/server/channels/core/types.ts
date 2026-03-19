export type OpenClawMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OpenClawContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
      };
    };

export type GatewayMessage = {
  role: "user" | "assistant";
  content: string | OpenClawContentPart[];
};

export type ChannelReply = {
  text: string;
  images?: Array<
    | {
        kind: "url";
        url: string;
        alt?: string;
      }
    | {
        kind: "data";
        mimeType: string;
        base64: string;
        filename?: string;
        alt?: string;
      }
  >;
};

export interface ExtractedChannelMessage {
  text: string;
  history?: OpenClawMessage[];
}

export type ExtractMessageResult<TMessage extends ExtractedChannelMessage> =
  | { kind: "message"; message: TMessage }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; reason: string };

export interface BootMessageHandle {
  update(text: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PlatformAdapter<
  TPayload = unknown,
  TMessage extends ExtractedChannelMessage = ExtractedChannelMessage,
> {
  extractMessage(
    payload: TPayload,
  ): ExtractMessageResult<TMessage> | Promise<ExtractMessageResult<TMessage>>;
  sendReply(message: TMessage, replyText: string): Promise<void>;
  sendReplyRich?(message: TMessage, reply: ChannelReply): Promise<void>;
  buildGatewayMessages?(
    message: TMessage,
  ): Promise<GatewayMessage[]> | GatewayMessage[];
  getSessionKey?(message: TMessage): string;
  startProcessingIndicator?(message: TMessage): Promise<import("@/server/channels/core/processing-indicator").ProcessingIndicator>;
  sendTypingIndicator?(message: TMessage): Promise<void>;
  clearTypingIndicator?(message: TMessage): Promise<void>;
  sendBootMessage?(message: TMessage, text: string): Promise<BootMessageHandle>;
}

type RetryableSendErrorOptions = {
  retryAfterSeconds?: number;
  cause?: unknown;
};

export class RetryableSendError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: RetryableSendErrorOptions = {}) {
    super(message);
    this.name = "RetryableSendError";
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
