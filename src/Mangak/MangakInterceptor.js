import { PaperbackInterceptor } from "@paperback/types";
function isHostOrSubdomain(url, domain) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
    }
    catch {
        return false;
    }
}
export class MangakInterceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        const isMangak = isHostOrSubdomain(request.url, "mangak.io");
        request.headers = {
            ...request.headers,
            referer: isMangak ? "https://mangak.io/" : "https://mangabuddy.com/",
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
