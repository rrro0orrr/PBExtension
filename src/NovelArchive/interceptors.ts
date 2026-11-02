import { CloudflareError, PaperbackInterceptor, Request, Response } from "@paperback/types";

const DOMAIN = "https://novelarchive.cc";

export class NovelArchiveInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    // The cover endpoint only redirects to the image when the request accepts images
    const isCover = /\/api\/novels\/[^/]+\/cover(?:\?|$)/.test(request.url);
    const isApi = request.url.startsWith(`${DOMAIN}/api/`) && !isCover;

    request.headers = {
      ...request.headers,
      referer: `${DOMAIN}/`,
      "user-agent": await Application.getDefaultUserAgent(),
      ...(isApi
        ? {
            origin: DOMAIN,
            accept: "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.5",
          }
        : {}),
      ...(isCover ? { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } : {}),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
      // API paths can't show the challenge; send the bypass to the site root
      // so one solve clears the cookie for the whole domain
      throw new CloudflareError({
        url: `${DOMAIN}/`,
        method: request.method ?? "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    return data;
  }
}
