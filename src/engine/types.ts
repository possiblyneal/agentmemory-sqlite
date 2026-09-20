export type TriggerActionType = { type: "enqueue"; queue: string } | { type: "void" };

export const TriggerAction = {
  Enqueue: (options: { queue: string }): TriggerActionType => ({
    type: "enqueue",
    queue: options.queue,
  }),
  Void: (): TriggerActionType => ({ type: "void" }),
} as const;

export type TriggerRequest<TInput = unknown> = {
  function_id: string;
  payload: TInput;
  action?: TriggerActionType;
  timeoutMs?: number;
};

export type RemoteFunctionHandler<TInput = any, TOutput = any> = (
  data: TInput,
) => Promise<TOutput>;

export type FunctionRef = { unregister: () => void };

export type Trigger = { unregister: () => void };

export type RegisterTriggerInput = {
  type: string;
  function_id: string;
  config: unknown;
  metadata?: Record<string, unknown>;
};

export type RegisterFunctionOptions = {
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ApiRequest<TBody = unknown> = {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
  request_body?: unknown;
};

export type ApiResponse<
  TStatus extends number = number,
  TBody = string | Buffer | Record<string, unknown>,
> = {
  status_code: TStatus;
  headers?: Record<string, string>;
  body?: TBody;
};

export interface ISdk {
  registerTrigger(trigger: RegisterTriggerInput): Trigger;
  registerFunction(
    functionId: string,
    handler: RemoteFunctionHandler,
    options?: RegisterFunctionOptions,
  ): FunctionRef;
  trigger<TInput = unknown, TOutput = any>(request: TriggerRequest<TInput>): Promise<TOutput>;
  shutdown(): Promise<void>;
  on?(event: string, listener: (payload?: unknown) => void): void;
}
