/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { PaperbackInterceptor, CloudflareError, } from "@paperback/types";
export class MainInterceptor extends PaperbackInterceptor {
    async interceptRequest(request) {
        const enableNsfw = request.headers?.["x-enable-nsfw"] === "true";
        if (enableNsfw) {
            const existingCookie = request.headers?.cookie || "";
            const additional = "show18PlusContent=true";
            const cookieHeader = existingCookie
                ? existingCookie.split(";").some((c) => c.trim().startsWith("show18PlusContent"))
                    ? existingCookie
                    : `${existingCookie}; ${additional}`
                : additional;
            request.headers = {
                ...request.headers,
                cookie: cookieHeader,
            };
        }
        if (request.headers) {
            delete request.headers["x-enable-nsfw"];
        }
        request.headers = {
            ...request.headers,
            origin: `https://mangaball.net`,
            "user-agent": await Application.getDefaultUserAgent(),
        };
        return request;
    }
    async interceptResponse(request, response, data) {
        const cfMitigated = response.headers?.["cf-mitigated"];
        if (cfMitigated === "challenge") {
            throw new CloudflareError({
                url: request.url,
                method: request.method ?? "GET",
                headers: {
                    "user-agent": await Application.getDefaultUserAgent(),
                },
            });
        }
        return data;
    }
}
