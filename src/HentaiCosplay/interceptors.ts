import { PaperbackInterceptor, Request, Response } from "@paperback/types";

export const HC_DOMAIN = "https://hentai-cosplay-xxx.com";

export class Interceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      referer: `${HC_DOMAIN}/`,
      // Must match the UA of the Cloudflare bypass web view exactly:
      // cf_clearance is bound to it, so a rewritten UA gets challenged again.
      "user-agent": await Application.getDefaultUserAgent(),
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
