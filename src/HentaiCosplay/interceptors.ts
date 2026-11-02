import { PaperbackInterceptor, Request, Response } from "@paperback/types";

export const HC_DOMAIN = "https://hentai-cosplay-xxx.com";

export class Interceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      referer: `${HC_DOMAIN}/`,
      // The site serves a broken mobile layout to iPhone user agents
      "user-agent": (await Application.getDefaultUserAgent()).replace(/iPhone/i, "iPad"),
    };
    request.url = request.url.replace(/^http:/, "https:");
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
