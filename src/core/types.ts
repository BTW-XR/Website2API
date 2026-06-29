export type ProviderName = 'amazon' | 'youtube';

export type ExtractType = 'search' | 'product' | 'video';

export interface ExtractRequest {
  url?: string;
  provider?: ProviderName;
  type?: ExtractType;
  query?: string;
  videoId?: string;
}

export interface ExtractSuccess<TData = unknown> {
  ok: true;
  provider: ProviderName;
  type: ExtractType;
  sourceUrl: string;
  data: TData;
}

export interface ExtractFailure {
  ok: false;
  code: string;
  error: string;
}

export type ExtractResponse<TData = unknown> = ExtractSuccess<TData> | ExtractFailure;

export class ExtractError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export function unsupported(message: string): never {
  throw new ExtractError('UNSUPPORTED_INPUT', message);
}
