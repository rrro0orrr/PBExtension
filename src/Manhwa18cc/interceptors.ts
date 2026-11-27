import { CloudflareError, PaperbackInterceptor, Request, Response } from "@paperback/types";

export const DOMAIN = "https://manhwa18.cc";

/** True when the URL's host is manhwa18.cc or one of its subdomains (e.g. img01). */
export function isManhwa18Url(url: string): boolean {
  const host = url.match(/^https?:\/\/([^/?#:@]+)(?::\d+)?(?:[/?#]|$)/i)?.[1]?.toLowerCase();
  return !!host && (host === "manhwa18.cc" || host.endsWith(".manhwa18.cc"));
}

export class Manhwa18Interceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      // The image CDN (img01.manhwa18.cc) refuses hotlinked requests.
      referer: request.headers?.referer ?? `${DOMAIN}/`,
      "user-agent": await Application.getDefaultUserAgent(),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (!isManhwa18Url(request.url)) return data;
    const challenged =
      response.headers?.["cf-mitigated"] === "challenge" ||
      ((response.status === 403 || response.status === 503) &&
        /Just a moment|_cf_chl_opt|cf-chl-/i.test(Application.arrayBufferToUTF8String(data)));
    if (challenged) {
      throw new CloudflareError({
        url: `${DOMAIN}/`,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    return data;
  }
}
