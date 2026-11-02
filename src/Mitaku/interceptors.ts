import { PaperbackInterceptor, Request, Response } from "@paperback/types";

export const MITAKU_DOMAIN = "https://mitaku.net";

export class Interceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      referer: `${MITAKU_DOMAIN}/`,
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
