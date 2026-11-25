import { CloudflareError, PaperbackInterceptor } from "@paperback/types";
export class NovelFireInterceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        request.headers = {
            ...request.headers,
            referer: `https://novelphoenix.com/`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        const cfMitigated = response.headers?.["cf-mitigated"];
        if (cfMitigated === "challenge") {
            // After a redirect to a mirror domain, response.url is the host that challenged us
            throw new CloudflareError({
                url: response.url || request.url,
                method: request.method ?? "GET",
                headers: {
                    "user-agent": await Application.getDefaultUserAgent(),
                },
            });
        }
        return data;
    }
}
