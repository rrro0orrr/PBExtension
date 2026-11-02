import { CloudflareError, PaperbackInterceptor, Request, Response } from "@paperback/types";

const DOMAIN = "https://www.mvlempyr.io";
const IMAGE_REGEX = /\.(avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

export class MVLEmpyrInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    const isApi = request.url.includes("/wp-json/");
    request.headers = {
      ...request.headers,
      referer: request.headers?.referer ?? `${DOMAIN}/`,
      origin: request.headers?.origin ?? DOMAIN,
      "user-agent": await Application.getDefaultUserAgent(),
      accept:
        request.headers?.accept ??
        (IMAGE_REGEX.test(request.url)
          ? "image/avif,image/webp,image/*,*/*;q=0.8"
          : isApi
            ? "application/json,*/*;q=0.8"
            : "text/html,application/xhtml+xml,*/*;q=0.8"),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const challenged =
      response.headers?.["cf-mitigated"] === "challenge" ||
      ((response.status === 403 || response.status === 503) &&
        /(?:Just a moment|cf-chl-|_cf_chl_opt)/i.test(
          (response.headers?.["content-type"] ?? "").includes("text/html")
            ? Application.arrayBufferToUTF8String(data)
            : "",
        ));
    if (challenged) {
      // JSON endpoints can't show the challenge page, so send the bypass to
      // the challenged host's root; solving it there clears the whole host
      const root = request.url.match(/^https?:\/\/[^/]+/)?.[0] ?? DOMAIN;
      throw new CloudflareError({
        url: `${root}/`,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    return data;
  }
}
