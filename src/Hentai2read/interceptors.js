import { PaperbackInterceptor } from "@paperback/types";
export class Hentai2readInterceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `https://hentai2read.com/`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
