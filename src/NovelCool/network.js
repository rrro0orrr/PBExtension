/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { CloudflareError, PaperbackInterceptor, } from "@paperback/types";
import * as cheerio from "cheerio";
import { API_HEADERS, API_PARAMETERS, API_URL, DESKTOP_USER_AGENT, DOMAIN, PAGE_SIZE, REQUIRED_COOKIES, STATE_KEYS, } from "./models";
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;
const isHttpUrl = (value) => /^https?:\/\/[^/\s]+/i.test(value);
const isNovelCoolUrl = (value) => {
    const host = value.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.split(":")[0] ?? "";
    return host === "novelcool.com" || host.endsWith(".novelcool.com");
};
const mergeRequiredCookies = (value) => {
    const cookies = value
        .split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => cookie.length > 0 && !/^novelcool_bad_user_\d+=/i.test(cookie));
    const names = new Set(cookies.map((cookie) => cookie.split("=", 1)[0]?.trim().toLowerCase()));
    for (const cookie of REQUIRED_COOKIES) {
        const name = cookie.split("=", 1)[0]?.toLowerCase();
        if (name && !names.has(name))
            cookies.push(cookie);
    }
    return cookies.join("; ");
};
export class NovelCoolInterceptor extends PaperbackInterceptor {
    prepareRequest(request, referer) {
        const headers = { ...request.headers };
        const cookie = headers.cookie ?? headers.Cookie ?? "";
        delete headers.Cookie;
        return {
            ...request,
            headers: {
                ...headers,
                cookie: mergeRequiredCookies(cookie),
                referer: referer ?? headers.referer ?? `${DOMAIN}/`,
                "user-agent": DESKTOP_USER_AGENT,
                accept: headers.accept ??
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
            },
        };
    }
    async interceptRequest(request) {
        if (request.url.startsWith(API_URL))
            return request;
        return this.prepareRequest(request);
    }
    async prepareRedirect(request, response) {
        if (!isHttpUrl(request.url) || !isNovelCoolUrl(request.url))
            return undefined;
        return this.prepareRequest(request, response.url);
    }
    async interceptResponse(request, response, data) {
        if (!request.url.startsWith(DOMAIN))
            return data;
        const contentType = response.headers?.["content-type"] ?? response.mimeType ?? "";
        const body = contentType.includes("text/html") ? Application.arrayBufferToUTF8String(data) : "";
        if (response.headers?.["cf-mitigated"] === "challenge" ||
            (response.status === 403 && request.url.startsWith(DOMAIN)) ||
            /(?:Just a moment|cf-chl-|_cf_chl_opt)/i.test(body)) {
            throw new CloudflareError({
                url: `${DOMAIN}/`,
                method: request.method ?? "GET",
                headers: { "user-agent": DESKTOP_USER_AGENT },
            });
        }
        return data;
    }
}
const siteUrl = (path) => {
    const value = Application.decodeHTMLEntities(path).trim();
    const url = /^https?:\/\//i.test(value)
        ? value
        : value.startsWith("//")
            ? `https:${value}`
            : URL_SCHEME_REGEX.test(value)
                ? ""
                : `${DOMAIN}${value.startsWith("/") ? "" : "/"}${value}`;
    const host = url.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.split(":")[0] ?? "";
    if (!url || (host !== "novelcool.com" && !host.endsWith(".novelcool.com"))) {
        throw new Error("NovelCool returned an unsupported content URL.");
    }
    return url;
};
const fetchDocument = async (url) => {
    const [response, buffer] = await Application.scheduleRequest({ url, method: "GET" });
    if (response.status === 404)
        throw new Error(`Content not found: ${url}`);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Request failed with status ${response.status}: ${url}`);
    }
    const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer), {
        xml: { xmlMode: false, decodeEntities: false },
    });
    if (/^404 Not Found$/i.test($("title").first().text().trim())) {
        throw new Error(`NovelCool returned its not-found page for ${url}.`);
    }
    const dateHeader = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "date")?.[1];
    const responseDate = Date.parse(dateHeader ?? "");
    Application.setState(Number.isNaN(responseDate) ? Date.now() : responseDate, STATE_KEYS.RELATIVE_DATE_ANCHOR);
    return $;
};
const formBody = (parameters) => Object.entries({ ...API_PARAMETERS, ...parameters })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
const fetchApi = async (path, parameters) => {
    const url = `${API_URL}/${path.replace(/^\/+|\/+$/g, "")}/`;
    const [response, buffer] = await Application.scheduleRequest({
        url,
        method: "POST",
        headers: API_HEADERS,
        body: formBody(parameters),
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`NovelCool API request failed with status ${response.status}: ${url}`);
    }
    let data;
    try {
        data = JSON.parse(Application.arrayBufferToUTF8String(buffer));
    }
    catch (error) {
        throw new Error(`Failed to parse NovelCool API response from ${url}`, { cause: error });
    }
    if (data.error_code !== "success") {
        throw new Error(data.error_msg || `NovelCool API request failed: ${url}`);
    }
    return data;
};
export const buildCategoryUrl = (path, page) => {
    const cleanPath = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const pagedPath = page <= 1 ? cleanPath : `${cleanPath.replace(/\.html$/i, "")}_${page}.html`;
    return siteUrl(pagedPath);
};
export const fetchCategoryPage = (path, page) => fetchDocument(buildCategoryUrl(path, page));
export const fetchUrlPage = (url) => fetchDocument(siteUrl(url));
export const fetchBrowse = (order, contentType, page) => fetchApi(`elite/${order}`, {
    lc_type: contentType,
    page: page.toString(),
    page_size: PAGE_SIZE.toString(),
});
export const fetchBookSearch = (query, contentType, page) => fetchApi("book/search", {
    keyword: query,
    lc_type: contentType,
    page: page.toString(),
    page_size: PAGE_SIZE.toString(),
});
export const fetchBookInfo = (bookId) => fetchApi("book/info", { book_id: bookId });
export const fetchBookChapters = (bookId) => fetchApi("chapter/book_list", { book_id: bookId });
export const fetchChapterInfo = (chapterId) => fetchApi("chapter/info", { chapter_id: chapterId });
