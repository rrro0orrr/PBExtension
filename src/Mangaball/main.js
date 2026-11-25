/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { BasicRateLimiter, ContentRating, CookieStorageInterceptor, DiscoverSectionType, URL, } from "@paperback/types";
import * as cheerio from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { MangaballSearchForm } from "./forms/SearchForm";
import { MangaballSettingsForm } from "./forms/SettingsForm";
import { STATIC_SEARCH_DETAILS, } from "./models";
import { MainInterceptor } from "./network";
import { parseApiItemsToDiscoverItems } from "./parsers";
import { isLanguageAllowed } from "./settings";
const baseUrl = "https://mangaball.net";
export class MangaballExtension {
    requestManager = new MainInterceptor("main");
    cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 10,
        bufferInterval: 1,
        ignoreImages: true,
    });
    cachedCsrfToken;
    cachedXsrfToken;
    cachedFormToken;
    csrfReady = false;
    async initialise() {
        this.requestManager.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
        await this.fetchCsrf(false);
    }
    async fetchCsrf(throwOnCF = false) {
        try {
            const [homeResp, homeData] = await Application.scheduleRequest({
                url: baseUrl,
                method: "GET",
                headers: {
                    Accept: "*/*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "user-agent": await Application.getDefaultUserAgent(),
                },
            });
            if (throwOnCF || (homeResp.status !== 503 && homeResp.status !== 403)) {
            }
            else if (homeResp.status === 503 || homeResp.status === 403) {
                this.csrfReady = false;
                return;
            }
            const homeHtml = Application.arrayBufferToUTF8String(homeData);
            const dom = htmlparser2.parseDocument(homeHtml);
            const $ = cheerio.load(dom);
            const metaToken = ($('meta[name="csrf-token"]').attr("content") || "").trim();
            let cookieToken;
            try {
                const cookies = this.cookieStorageInterceptor?.cookies ?? [];
                for (const c of cookies) {
                    const name = (c.name || "").toLowerCase();
                    if (name.includes("xsrf") || name.includes("csrf")) {
                        try {
                            cookieToken = decodeURIComponent(c.value || "");
                        }
                        catch {
                            cookieToken = c.value || "";
                        }
                        break;
                    }
                }
            }
            catch {
                throw new Error("Failed to access cookies for CSRF token extraction");
            }
            let scriptToken;
            if (!metaToken) {
                const scriptsCombined = $("script")
                    .map((_, el) => $(el).html() || "")
                    .get()
                    .join("\n");
                const m1 = scriptsCombined.match(/csrfToken\s*[:=]\s*["']([^"']+)["']/i);
                if (m1)
                    scriptToken = m1[1];
                else {
                    const m2 = scriptsCombined.match(/window\.Laravel\s*=\s*\{[\s\S]*?csrfToken\s*:\s*["']([^"']+)["']/i);
                    if (m2)
                        scriptToken = m2[1];
                }
            }
            this.cachedCsrfToken = metaToken || cookieToken || scriptToken || "";
            this.cachedXsrfToken = cookieToken || metaToken || scriptToken || "";
            this.cachedFormToken = metaToken || cookieToken || scriptToken || "";
            this.csrfReady = true;
        }
        catch (err) {
            this.csrfReady = false;
            console.log("[init] Failed to fetch CSRF/cookie:", err);
        }
    }
    async getDiscoverSections() {
        return [
            {
                id: "popular_updates_section",
                title: "Popular Updates",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest_releases_section",
                title: "Latest Releases",
                type: DiscoverSectionType.chapterUpdates,
            },
            {
                id: "manga_recommend_section",
                title: "Manga Recommend",
                type: DiscoverSectionType.prominentCarousel,
            },
            {
                id: "manga_of_day_section",
                title: "Manga of the Day",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "chapter_of_day_section",
                title: "Chapter of the Day",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }
    formEncode(params) {
        return Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&");
    }
    async searchAPI(search_type, search_limit) {
        const bodyParams = { search_type };
        if (search_limit !== undefined)
            bodyParams.search_limit = search_limit;
        await this.fetchCsrf(true);
        const headers = {
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Referer: `https://mangaball.net/search-advanced/`,
            "X-Requested-With": "XMLHttpRequest",
            "user-agent": await Application.getDefaultUserAgent(),
        };
        if (this.cachedCsrfToken) {
            headers["X-CSRF-TOKEN"] = this.cachedCsrfToken;
        }
        if (this.cachedXsrfToken) {
            headers["X-XSRF-TOKEN"] = this.cachedXsrfToken;
        }
        if (this.cachedFormToken) {
            bodyParams._token = this.cachedFormToken;
        }
        const apiUrl = new URL(baseUrl)
            .addPathComponent("api")
            .addPathComponent("v1")
            .addPathComponent("title")
            .addPathComponent("search")
            .toString();
        const formBody = this.formEncode(bodyParams);
        const request = {
            url: apiUrl,
            method: "POST",
            body: formBody,
            headers,
        };
        try {
            const [_, data] = await Application.scheduleRequest(request);
            const jsonStr = Application.arrayBufferToUTF8String(data);
            const responseAPI = JSON.parse(jsonStr);
            return responseAPI;
        }
        catch (err) {
            console.error(`[searchAPI] Failed for type=${search_type}:`, err);
            throw err;
        }
    }
    async getDiscoverSectionItems(section) {
        switch (section.id) {
            case "popular_updates_section":
                return this.getPopularSectionItems(section);
            case "latest_releases_section":
                return this.getUpdatedSectionItems(section);
            case "manga_of_day_section":
                return this.getMangaOfDaySectionItems(section);
            case "manga_recommend_section":
                return this.getMangaRecommendSectionItems(section);
            case "chapter_of_day_section":
                return this.getChapterOfDaySectionItems(section);
            default:
                return { items: [] };
        }
    }
    async getSortingOptions(_query) {
        return STATIC_SEARCH_DETAILS.sortBy.map((sort) => ({
            id: sort.id,
            label: sort.label,
        }));
    }
    async getAdvancedSearchForm(query) {
        const meta = query.metadata?.searchMeta;
        return new MangaballSearchForm(meta);
    }
    async getSearchResults(query, metadata, sortingOption) {
        const paginationMeta = metadata;
        const page = paginationMeta?.page ?? 1;
        const collectedIds = paginationMeta?.searchCollectedIds ?? [];
        const searchMeta = query.metadata
            ?.searchMeta;
        const nsfw = searchMeta?.nsfw ?? false;
        const tag_included_ids = searchMeta?.tagIncluded ?? [];
        const tag_excluded_ids = searchMeta?.tagExcluded ?? [];
        const demographic = searchMeta?.demographic ?? "any";
        const originalLanguages = searchMeta?.originalLanguages ?? [];
        const sort = sortingOption?.id || "none";
        const search_input = query.title?.trim() || "";
        const filters = {
            sort,
            tag_included_mode: "and",
            tag_excluded_mode: "and",
            contentRating: "any",
            demographic,
            publicationStatus: "any",
            userSettingsEnabled: false,
        };
        if (tag_included_ids.length > 0)
            filters["tag_included_ids"] = tag_included_ids;
        if (tag_excluded_ids.length > 0)
            filters["tag_excluded_ids"] = tag_excluded_ids;
        if (originalLanguages.length > 0)
            filters["originalLanguages"] = originalLanguages.join(",");
        filters["page"] = page;
        const formBody = [
            `search_input=${encodeURIComponent(search_input)}`,
            ...Object.entries(filters).flatMap(([k, v]) => {
                if (Array.isArray(v)) {
                    return v.map((val) => `${encodeURIComponent(`filters[${k}][]`)}=${encodeURIComponent(String(val))}`);
                }
                else {
                    return `${encodeURIComponent(`filters[${k}]`)}=${encodeURIComponent(String(v))}`;
                }
            }),
        ].join("&");
        await this.fetchCsrf(true);
        const headers = {
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Origin: baseUrl.replace(/\/$/, ""),
            Referer: baseUrl + "search-advanced",
            "X-Requested-With": "XMLHttpRequest",
            "user-agent": await Application.getDefaultUserAgent(),
        };
        if (nsfw) {
            headers["x-enable-nsfw"] = "true";
        }
        if (this.cachedCsrfToken)
            headers["X-CSRF-TOKEN"] = this.cachedCsrfToken;
        if (this.cachedXsrfToken)
            headers["X-XSRF-TOKEN"] = this.cachedXsrfToken;
        if (this.cachedFormToken)
            headers["x-csrf-token"] = this.cachedFormToken;
        const apiUrl = new URL(baseUrl)
            .addPathComponent("api")
            .addPathComponent("v1")
            .addPathComponent("title")
            .addPathComponent("search-advanced")
            .toString();
        const request = {
            url: apiUrl,
            method: "POST",
            body: formBody,
            headers,
        };
        try {
            const [_, data] = await Application.scheduleRequest(request);
            const jsonStr = Application.arrayBufferToUTF8String(data);
            const response = JSON.parse(jsonStr);
            const searchResults = [];
            for (const raw of response.data ?? []) {
                let mangaId = raw.url;
                const idMatch = raw.url.match(/\/title-detail\/([^/?#]+)/);
                if (idMatch) {
                    mangaId = idMatch[1];
                }
                else {
                    mangaId = raw.url.split("/").filter(Boolean).pop() || raw.url;
                }
                collectedIds.push(mangaId);
                let altTitles = [];
                if (raw.alternateName) {
                    try {
                        const $alt = cheerio.load(String(raw.alternateName));
                        altTitles = $alt("span")
                            .map((_, el) => $alt(el).text().trim())
                            .get();
                    }
                    catch { }
                }
                let tagNames = [];
                if (raw.tags) {
                    try {
                        const $tags = cheerio.load(String(raw.tags));
                        tagNames = $tags("span")
                            .map((_, el) => $tags(el).text().trim())
                            .get();
                    }
                    catch { }
                }
                let authorNames = [];
                if (raw.authors) {
                    try {
                        const $auth = cheerio.load(String(raw.authors));
                        authorNames = $auth("span")
                            .map((_, el) => $auth(el).text().trim())
                            .get();
                    }
                    catch { }
                }
                let statusText = "";
                if (raw.status) {
                    try {
                        const $status = cheerio.load(String(raw.status));
                        statusText = $status("span").first().text().trim();
                    }
                    catch {
                        statusText = String(raw.status);
                    }
                }
                let latestChapter = "";
                if (raw.last_chapter) {
                    try {
                        const $lc = cheerio.load(String(raw.last_chapter));
                        latestChapter = $lc("a").first().text().trim();
                        if (!latestChapter) {
                            latestChapter = $lc.root().text().trim();
                        }
                    }
                    catch {
                        latestChapter = String(raw.last_chapter)
                            .replace(/<[^>]*>?/gm, "")
                            .replace(/[<>]/g, "")
                            .trim();
                    }
                }
                let subtitle = toRelativeTime(raw.updated_at);
                if (latestChapter) {
                    subtitle = `${latestChapter} | ${subtitle}`;
                }
                searchResults.push({
                    mangaId: mangaId,
                    imageUrl: String(raw.cover || raw.background || ""),
                    title: String(raw.name || ""),
                    subtitle: subtitle,
                    metadata: {
                        chapterId: raw.last_chapter || undefined,
                        altTitles,
                        tagNames,
                        authorNames,
                        statusText,
                        originalId: raw._id,
                        originalUrl: raw.url,
                    },
                });
            }
            let nextPage = undefined;
            if (response.pagination && response.pagination.current_page < response.pagination.last_page) {
                nextPage = response.pagination.current_page + 1;
            }
            return {
                items: searchResults,
                metadata: nextPage ? { page: nextPage, searchCollectedIds: collectedIds } : undefined,
            };
        }
        catch (err) {
            console.error(`[getSearchResults] Failed:`, err);
            throw err;
        }
    }
    async getMangaDetails(mangaId) {
        const request = {
            url: new URL(baseUrl).addPathComponent("title-detail").addPathComponent(mangaId).toString(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const title = $("#comicDetail h6").first().text().trim();
        const altTitles = [];
        $(".alternate-name-container span").each((_, el) => {
            const t = $(el).text().trim();
            if (t)
                altTitles.push(t);
        });
        let image = $(".featured-cover").attr("src") || $(".featured-cover").attr("data-src") || "";
        if (image && !image.startsWith("http")) {
            image = image.startsWith("/") ? `${baseUrl}${image.slice(1)}` : `${baseUrl}${image}`;
        }
        const description = $(".description-text p").html() || "";
        const authors = [];
        $(".badge.bg-secondary.bg-opacity-75 i.fa-user-edit")
            .parent()
            .nextAll("span")
            .each((_, el) => {
            const t = $(el).text().trim();
            if (t)
                authors.push(t);
        });
        let status = $(".badge.bg-success.me-3").first().text().trim();
        if (!status)
            status = $(".badge.bg-danger.me-3").first().text().trim();
        const tagGroups = [];
        const tagBadges = $(".badge.bg-success,.badge.bg-info,.badge.bg-warning,.badge.bg-danger").filter(function () {
            return !!$(this).attr("data-tag-id");
        });
        if (tagBadges.length > 0) {
            tagGroups.push({
                id: "tags",
                title: "Tags",
                tags: tagBadges
                    .map((_, el) => ({
                    id: $(el).attr("data-tag-id") || "",
                    title: $(el).text().trim(),
                }))
                    .get(),
            });
        }
        let rating = 0;
        const ratingText = $(".fa-star.text-warning").parent().find("span").text().trim();
        if (ratingText) {
            const parsed = parseFloat(ratingText);
            if (!isNaN(parsed))
                rating = parsed;
        }
        return {
            mangaId: mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: altTitles,
                thumbnailUrl: image,
                synopsis: description,
                rating,
                contentRating: ContentRating.EVERYONE,
                status,
                tagGroups,
                shareUrl: request.url,
                author: authors.join(", "),
            },
        };
    }
    async getSettingsForm() {
        return new MangaballSettingsForm();
    }
    async getChapters(sourceManga) {
        const mangaId = sourceManga.mangaId;
        const match = mangaId.match(/([a-f0-9]{24})$/);
        const titleId = match ? match[1] : mangaId;
        const csrfToken = this.cachedFormToken || this.cachedCsrfToken || "";
        const apiUrl = new URL(baseUrl)
            .addPathComponent("api")
            .addPathComponent("v1")
            .addPathComponent("chapter")
            .addPathComponent("chapter-listing-by-title-id")
            .toString();
        const headers = {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            origin: baseUrl.replace(/\/$/, ""),
            referer: `${baseUrl}title-detail/${mangaId}/`,
            "user-agent": await Application.getDefaultUserAgent(),
            "x-csrf-token": csrfToken,
            "x-requested-with": "XMLHttpRequest",
        };
        const body = `title_id=${encodeURIComponent(titleId)}`;
        const request = {
            url: apiUrl,
            method: "POST",
            headers,
            body,
        };
        const [_, data] = await Application.scheduleRequest(request);
        const json = JSON.parse(Application.arrayBufferToUTF8String(data)); // Assume valid response
        const chapters = [];
        const seen = new Set();
        for (const ch of json.ALL_CHAPTERS ?? []) {
            for (const t of ch.translations ?? []) {
                const language = (t.language || t.languageName || "").trim();
                if (!isLanguageAllowed(t.language || "", t.languageName))
                    continue;
                const seenKey = `${t.id}:${language.toLowerCase()}`;
                if (seen.has(seenKey))
                    continue;
                seen.add(seenKey);
                const version = [t.group?._id?.trim(), language].filter(Boolean).join(" ");
                chapters.push({
                    chapterId: t.id,
                    sourceManga,
                    title: t.name || ch.title || ch.number || "",
                    volume: t.volume || 0,
                    chapNum: ch.number_float || 0,
                    publishDate: t.date ? new Date(t.date) : undefined,
                    langCode: language,
                    version,
                });
            }
        }
        return chapters;
    }
    async getChapterDetails(chapter) {
        const request = {
            url: new URL(baseUrl)
                .addPathComponent("chapter-detail")
                .addPathComponent(chapter.chapterId)
                .toString(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const pages = [];
        const script = $("script")
            .filter((_, el) => {
            const html = $(el).html() || "";
            return html.includes("const chapterImages = JSON.parse(");
        })
            .first()
            .html();
        if (script) {
            const match = script.match(/const chapterImages\s*=\s*JSON\.parse\(`(.+?)`\)/s);
            if (match) {
                try {
                    const images = JSON.parse(match[1]);
                    if (Array.isArray(images)) {
                        pages.push(...images);
                    }
                }
                catch {
                    throw new Error("Failed to parse chapter images");
                }
            }
        }
        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages: pages,
        };
    }
    async getUpdatedSectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        const latest = await this.searchAPI("getLatestTable");
        const parsed = parseApiItemsToDiscoverItems(latest?.data ?? [], collectedIds, {
            itemType: "chapterUpdatesCarouselItem",
            extractChapterInfo: true,
            customSubtitleExtractor: (raw) => {
                return String(raw.updated_at || "");
            },
        });
        return { items: parsed.items, metadata: { page: page + 1, collectedIds: parsed.collectedIds } };
    }
    async getPopularSectionItems(_section) {
        const Popular = await this.searchAPI("getFeatured");
        const page = 1;
        const collectedIds = [];
        const parsed = parseApiItemsToDiscoverItems(Popular.data, collectedIds);
        return { items: parsed.items, metadata: { page: page + 1, collectedIds: parsed.collectedIds } };
    }
    async getMangaOfDaySectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        const recent = await this.searchAPI("getRecentRead");
        const parsed = parseApiItemsToDiscoverItems(recent?.data ?? [], collectedIds, {
            customSubtitleExtractor: (raw) => String(raw.updated_at || ""),
        });
        return { items: parsed.items, metadata: { page: page + 1, collectedIds: parsed.collectedIds } };
    }
    async getMangaRecommendSectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        const recommend = await this.searchAPI("getRecommend");
        const parsed = parseApiItemsToDiscoverItems(recommend?.data ?? [], collectedIds);
        return { items: parsed.items, metadata: { page: page + 1, collectedIds: parsed.collectedIds } };
    }
    async getChapterOfDaySectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        const recent = await this.searchAPI("getRecentChapterRead");
        const parsed = parseApiItemsToDiscoverItems(recent?.data ?? [], collectedIds, {
            customSubtitleExtractor: (raw) => String(raw.updated_at || ""),
        });
        return { items: parsed.items, metadata: { page: page + 1, collectedIds: parsed.collectedIds } };
    }
    async saveCloudflareBypassCookies(cookies) {
        for (const cookie of this.cookieStorageInterceptor.cookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }
        for (const cookie of cookies) {
            if (cookie.expires && cookie.expires.getTime() <= Date.now()) {
                continue;
            }
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }
    async fetchCheerio(request) {
        const [_, data] = await Application.scheduleRequest(request);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}
function toRelativeTime(dateText) {
    if (!dateText || typeof dateText !== "string" || !dateText.trim()) {
        return "";
    }
    const now = Date.now();
    let date;
    const trimmed = dateText.trim();
    if (/^\d{10,13}$/.test(trimmed)) {
        if (trimmed.length === 13) {
            date = new Date(Number(trimmed));
        }
        else if (trimmed.length === 10) {
            date = new Date(Number(trimmed) * 1000);
        }
    }
    else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
        const m = dateText.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (m) {
            date = new Date(Number(m[1]), // year
            Number(m[2]) - 1, // month (0-based)
            Number(m[3]), // day
            Number(m[4]), // hour
            Number(m[5]), // minute
            Number(m[6]));
        }
    }
    else if (!isNaN(Date.parse(trimmed))) {
        date = new Date(trimmed);
    }
    if (!date || isNaN(date.getTime())) {
        return trimmed;
    }
    const diff = Math.floor((now - date.getTime()) / 1000);
    if (diff < 60)
        return "just now";
    if (diff < 3600)
        return `${Math.floor(diff / 60)} minute${Math.floor(diff / 60) === 1 ? "" : "s"} ago`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)} hour${Math.floor(diff / 3600) === 1 ? "" : "s"} ago`;
    if (diff < 2592000)
        return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) === 1 ? "" : "s"} ago`;
    if (diff < 31536000)
        return `${Math.floor(diff / 2592000)} month${Math.floor(diff / 2592000) === 1 ? "" : "s"} ago`;
    return `${Math.floor(diff / 31536000)} year${Math.floor(diff / 31536000) === 1 ? "" : "s"} ago`;
}
export const Mangaball = new MangaballExtension();
