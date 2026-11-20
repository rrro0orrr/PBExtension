import { CloudflareError, PaperbackInterceptor, Request, Response } from "@paperback/types";

export const DOMAIN = "https://toonz.to";

export class ToonzInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    const headers = { ...request.headers };
    // The site's reader_prefs cookie can switch the chapter page to a layout
    // without the image list, so never send it (as Keiyoushi's extension does).
    const cookieHeader = headers.cookie ?? headers.Cookie;
    if (cookieHeader) {
      delete headers.Cookie;
      const kept = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith("reader_prefs="));
      if (kept.length) headers.cookie = kept.join("; ");
      else delete headers.cookie;
    }
    if (request.cookies?.reader_prefs !== undefined) {
      const { reader_prefs: _dropped, ...rest } = request.cookies;
      request.cookies = rest;
    }
    request.headers = {
      ...headers,
      referer: headers.referer ?? `${DOMAIN}/`,
      "user-agent": await Application.getDefaultUserAgent(),
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (!request.url.startsWith(DOMAIN)) return data;
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
