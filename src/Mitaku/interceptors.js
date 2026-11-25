import { PaperbackInterceptor } from "@paperback/types";
export const MITAKU_DOMAIN = "https://mitaku.net";
export class Interceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `${MITAKU_DOMAIN}/`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
