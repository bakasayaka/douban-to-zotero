export interface ModelHttpResponse {
  statusCode: number;
  responseText: string;
}

export interface OpenAICompatibleTransport {
  postJson(
    url: string,
    apiKey: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<ModelHttpResponse>;
}

export class ZoteroOpenAICompatibleTransport implements OpenAICompatibleTransport {
  async postJson(
    url: string,
    apiKey: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<ModelHttpResponse> {
    const options: Record<string, unknown> = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
    if (timeoutMs !== undefined) {
      options.timeout = timeoutMs;
    }

    const response = await Zotero.HTTP.request("POST", url, options as any);
    return {
      statusCode: typeof response.status === "number" ? response.status : 0,
      responseText: response.responseText,
    };
  }
}

export class FetchOpenAICompatibleTransport implements OpenAICompatibleTransport {
  async postJson(
    url: string,
    apiKey: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<ModelHttpResponse> {
    const controller = timeoutMs ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      return {
        statusCode: response.status,
        responseText: await response.text(),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
