/**
 * 带限流的 HTTP 请求封装
 * 在请求之间加入 2-5 秒随机延迟，遇到 403 或验证码时抛出错误
 */

export class RateLimitError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserError";
  }
}

function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起带限流的 GET 请求
 * @param url 目标 URL
 * @param options 配置项
 * @returns 响应 HTML 文本
 */
export async function fetchWithDelay(
  url: string,
  options?: {
    minDelay?: number;
    maxDelay?: number;
    retries?: number;
  },
): Promise<string> {
  const minDelay = options?.minDelay ?? 2000;
  const maxDelay = options?.maxDelay ?? 5000;
  const retries = options?.retries ?? 3;

  // 请求前等待随机延迟
  await randomDelay(minDelay, maxDelay);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await Zotero.HTTP.request("GET", url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        responseType: "text",
      });

      const status = response.status;

      if (status === 403 || status === 418) {
        throw new RateLimitError(
          `豆瓣返回 ${status}，可能触发了反爬机制。请稍后重试。`,
          status,
        );
      }

      if (status === 404) {
        throw new Error(`页面不存在: ${url}`);
      }

      if (status >= 400) {
        throw new Error(`HTTP ${status}: ${url}`);
      }

      // 检测是否返回了验证码页面
      const text = response.responseText;
      if (
        text.includes("sec.douban.com") ||
        text.includes("验证码") ||
        text.includes("captcha")
      ) {
        throw new RateLimitError(
          "豆瓣要求验证码验证，请稍后重试。",
          403,
        );
      }

      return text;
    } catch (e: any) {
      lastError = e;

      // 不重试限流错误
      if (e instanceof RateLimitError) {
        throw e;
      }

      // 指数退避重试
      if (attempt < retries - 1) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        await randomDelay(backoff, backoff + 2000);
      }
    }
  }

  throw lastError || new Error(`请求失败: ${url}`);
}
