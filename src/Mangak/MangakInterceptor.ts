import { PaperbackInterceptor, Request, Response } from "@paperback/types";

function isMangakUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "mangak.io" || host.endsWith(".mangak.io");
  } catch {
    return false;
  }
}

export class MangakInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    const isMangak = isMangakUrl(request.url);
    request.headers = {
      ...request.headers,
      referer: isMangak ? "https://mangak.io/" : "https://mangabuddy.com/",
      "user-agent": await Application.getDefaultUserAgent(),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    return data;
  }
}
