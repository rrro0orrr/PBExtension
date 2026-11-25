import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import * as cheerio from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { URLBuilder } from "../utils/url-builder/base";
import { MangabuddySearchForm } from "./forms/SearchForm";
import { MangakInterceptor } from "./MangakInterceptor";
const baseUrl = "https://mangak.io";
export class MangakExtension {
    requestManager = new MangakInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 5,
        bufferInterval: 1,
        ignoreImages: true,
    });
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    async initialise() {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
        this.requestManager?.registerInterceptor();
    }
    async getDiscoverSections() {
        return [
            {
                id: "popular_section",
                title: "Popular",
                type: DiscoverSectionType.featured,
            },
            {
                id: "updated_section",
                title: "Recently Updated",
                type: DiscoverSectionType.chapterUpdates,
            },
        ];
    }
    async getDiscoverSectionItems(section, metadata) {
        switch (section.id) {
            case "popular_section":
                return this.getPopularSectionItems(section);
            case "updated_section":
                return this.getUpdatedSectionItems(section, metadata);
            default:
                return { items: [] };
        }
    }
    async getAdvancedSearchForm(query) {
        const meta = query.metadata?.searchMeta;
        return new MangabuddySearchForm(meta);
    }
    async getSearchResults(query, metadata) {
        const page = metadata?.page ?? 1;
        const searchMeta = query.metadata
            ?.searchMeta;
        const genreIncluded = searchMeta?.genreIncluded ?? [];
        const genreExcluded = searchMeta?.genreExcluded ?? [];
        const status = searchMeta?.status ?? "all";
        const orderby = searchMeta?.orderby ?? "";
        const apiUrl = new URLBuilder("https://api.mangak.io")
            .addPath("titles")
            .addPath("search")
            .addQuery("q", query.title ?? "")
            .addQuery("page", page.toString())
            .addQuery("limit", "24");
        // Only send sort when user explicitly picked one — omitting it gives relevance ranking
        if (orderby && orderby !== "relevance") {
            apiUrl.addQuery("sort", orderby);
        }
        if (status && status !== "all") {
            apiUrl.addQuery("status", status);
        }
        for (const id of genreIncluded) {
            apiUrl.addQuery("include[]", id);
        }
        for (const id of genreExcluded) {
            apiUrl.addQuery("exclude[]", id);
        }
        const [response, data] = await Application.scheduleRequest({
            url: apiUrl.build(),
            method: "GET",
            headers: { origin: "https://mangak.io", referer: "https://mangak.io/" },
        });
        this.checkCloudflareStatus(response.status);
        const json = JSON.parse(Application.arrayBufferToUTF8String(data));
        if (!json.success || !json.data)
            return { items: [] };
        const items = json.data.items
            .filter((item) => item.slug)
            .map((item) => ({
            mangaId: item.slug,
            imageUrl: item.cover ?? "",
            title: item.name ?? "",
            subtitle: item.latest_chapters?.[0]?.name,
        }));
        return {
            items,
            metadata: json.data.pagination.has_next ? { page: page + 1 } : undefined,
        };
    }
    async getMangaDetails(mangaId) {
        const normalizedMangaId = normalizeMangaId(mangaId);
        const pageProps = await this.fetchNextData(`${baseUrl}/${normalizedMangaId}`);
        const manga = pageProps.initialManga;
        if (!manga)
            throw new Error(`Manga not found: ${normalizedMangaId}`);
        const altTitles = (manga.altNames ?? [])
            .flatMap((a) => a.name.split(/\s*,\s*/))
            .map((t) => t.trim())
            .filter((t) => t && t.toLowerCase() !== manga.name.toLowerCase());
        const statusText = (manga.status ?? "").toLowerCase();
        const status = statusText.includes("ongoing")
            ? "ONGOING"
            : statusText.includes("completed")
                ? "COMPLETED"
                : "UNKNOWN";
        const tags = [];
        const genres = manga.genres ?? [];
        if (genres.length > 0) {
            tags.push({
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: g.slug, title: g.name })),
            });
        }
        return {
            mangaId: normalizedMangaId,
            mangaInfo: {
                primaryTitle: manga.name,
                secondaryTitles: altTitles,
                thumbnailUrl: manga.cover ?? "",
                synopsis: manga.summary ?? "",
                rating: manga.rating ?? 0,
                contentRating: ContentRating.EVERYONE,
                status: status,
                tagGroups: tags,
            },
        };
    }
    async getChapters(sourceManga) {
        const $ = await this.fetchCheerio({
            url: `${baseUrl}/${sourceManga.mangaId}`,
            method: "GET",
        });
        const nextDataText = $("#__NEXT_DATA__").html() || "{}";
        let internalId;
        try {
            const nextData = JSON.parse(nextDataText);
            internalId = nextData?.props?.pageProps?.initialManga?.id;
            if (!internalId)
                throw new Error("missing id");
        }
        catch {
            throw new Error(`Could not extract internal manga ID for ${sourceManga.mangaId}`);
        }
        const [response, data] = await Application.scheduleRequest({
            url: `https://api.mangak.io/titles/${internalId}/chapters`,
            method: "GET",
        });
        this.checkCloudflareStatus(response.status);
        const json = JSON.parse(Application.arrayBufferToUTF8String(data));
        if (!json.success || !Array.isArray(json.data?.chapters))
            return [];
        return json.data.chapters.map((ch, index) => {
            const nameMatch = ch.name?.match(/(\d+(?:\.\d+)?)/);
            const chapNum = nameMatch ? Number(nameMatch[1]) : (ch.chapter_number ?? index + 1);
            return {
                chapterId: ch.slug,
                title: ch.name ?? "",
                sourceManga,
                chapNum,
                publishDate: ch.updated_at ? new Date(ch.updated_at) : undefined,
                volume: undefined,
                langCode: "🇬🇧",
            };
        });
    }
    async getChapterDetails(chapter) {
        const chapterUrl = `${baseUrl}/${chapter.sourceManga.mangaId}/${chapter.chapterId}`;
        const pageProps = await this.fetchNextData(chapterUrl);
        const initialChapter = pageProps?.initialChapter;
        const pages = Array.isArray(initialChapter?.images)
            ? initialChapter.images.filter((p) => typeof p === "string" && p.length > 0)
            : [];
        if (!pages.length) {
            throw new Error(`No images found for chapter ${chapter.chapterId}`);
        }
        return {
            mangaId: chapter.sourceManga.mangaId,
            id: chapter.chapterId,
            pages,
        };
    }
    getMangaShareUrl(mangaId) {
        return `${baseUrl}/${normalizeMangaId(mangaId)}`;
    }
    async getUpdatedSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const pageProps = await this.fetchNextData(`${baseUrl}/latest?sort=latest&page=${page}`);
        const rawItems = pageProps.items ?? [];
        const pagination = pageProps.pagination;
        const items = rawItems
            .filter((item) => item.slug)
            .map((item) => ({
            type: "chapterUpdatesCarouselItem",
            mangaId: item.slug,
            imageUrl: item.cover ?? "",
            title: item.name ?? "",
            subtitle: item.latestChapters?.[0]?.name,
            chapterId: item.latestChapters?.[0]?.slug ?? "",
            metadata: undefined,
        }));
        return {
            items,
            metadata: pagination?.has_next ? { page: page + 1 } : undefined,
        };
    }
    async getPopularSectionItems(
    /* eslint-disable @typescript-eslint/no-unused-vars */
    section) {
        const page = 1;
        const collectedIds = [];
        const request = {
            url: `${baseUrl}/top/day`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        const elements = $(".top-item").length ? $(".top-item") : $("article.group, .group");
        elements.each((_, element) => {
            const unit = $(element);
            const image = unit.find("img").first().attr("data-src") || unit.find("img").first().attr("src") || "";
            const hrefAnchor = unit.find("a[aria-label]").first().attr("href") ||
                unit.find("a[title]").first().attr("href") ||
                unit.find("a").first().attr("href") ||
                "";
            const mangaId = normalizeMangaId(hrefAnchor);
            const title = unit.find("a[title]").first().attr("title") ||
                unit.find(".meta .title a").text().trim() ||
                unit.find("a > span").first().text().trim() ||
                (unit.find("img").first().attr("alt") || "").toString();
            const latestChapter = unit.find('a[href*="/chapter"]').first().text().trim() ||
                unit.find('a[href*="/notice"]').first().text().trim() ||
                unit.find(".thumb .latest-chapter").text().trim() ||
                "";
            const views = unit.find('span[title="Views"] .tabular-nums').first().text().trim() ||
                unit.find('span[title="Views"] span').last().text().trim() ||
                "";
            const chapterMatch = latestChapter.match(/Chapter\s*([0-9]+(?:\.[0-9]+)?)/i);
            const supertitle = views || (chapterMatch ? `Ch. ${chapterMatch[1]}` : latestChapter || "");
            if (title && mangaId) {
                items.push({
                    type: "featuredCarouselItem",
                    mangaId: mangaId,
                    imageUrl: image,
                    title: title,
                    supertitle: supertitle || undefined,
                    metadata: undefined,
                });
            }
        });
        return {
            items: items,
            metadata: undefined,
        };
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
    checkCloudflareStatus(status) {
        if (status == 503 || status == 403) {
            throw new CloudflareError({ url: baseUrl, method: "GET" });
        }
    }
    async fetchNextData(url) {
        const $ = await this.fetchCheerio({ url, method: "GET" });
        const raw = $("#__NEXT_DATA__").html() || "{}";
        const doc = JSON.parse(raw);
        return doc?.props?.pageProps ?? {};
    }
    async fetchCheerio(request) {
        const [response, data] = await Application.scheduleRequest(request);
        this.checkCloudflareStatus(response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}
function normalizeMangaId(hrefOrId) {
    if (!hrefOrId)
        return "";
    try {
        const parsedUrl = new URL(hrefOrId, baseUrl);
        return parsedUrl.pathname.replace(/^\/+|\/+$/g, "");
    }
    catch {
        return hrefOrId.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+|\/+$/g, "");
    }
}
export const Mangak = new MangakExtension();
