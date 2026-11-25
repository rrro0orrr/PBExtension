import { PaperbackInterceptor } from "@paperback/types";
export class ScribbleHubInterceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `https://www.scribblehub.com/`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        return data;
    }
}
