import { PaperbackInterceptor } from "@paperback/types";
export const OS_DOMAIN = "https://ososedki.com";
export class Interceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `${OS_DOMAIN}/`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
