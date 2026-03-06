export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(
    500,
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unexpected error",
  );
}

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

export function jsonError(error: unknown, init?: ResponseInit): Response {
  const apiError = toApiError(error);
  return Response.json(
    {
      error: apiError.code,
      message: apiError.message,
    },
    {
      status: init?.status ?? apiError.status,
      headers: init?.headers,
    },
  );
}
