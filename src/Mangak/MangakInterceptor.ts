import { PaperbackInterceptor, Request, Response } from "@paperback/types";

function isHostOrSubdomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export class MangakInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    const isMangak = isHostOrSubdomain(request.url, "mangak.io");
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
