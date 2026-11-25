import { PaperbackInterceptor } from "@paperback/types";
export const HC_DOMAIN = "https://hentai-cosplay-xxx.com";
export class Interceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `${HC_DOMAIN}/`,
            // The site serves a broken mobile layout to iPhone user agents
            "user-agent": (await Application.getDefaultUserAgent()).replace(/iPhone/i, "iPad"),
        };
        request.url = request.url.replace(/^http:/, "https:");
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
