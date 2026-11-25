import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import * as cheerio from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { MangacloudSearchForm } from "./forms/SearchForm";
import { MangacloudInterceptor } from "./interceptors";
import { SortOptions, } from "./model";
const baseUrl = "https://mangacloud.org/";
export class MangacloudExtension {
    requestManager = new MangacloudInterceptor("main");
    cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 10,
        bufferInterval: 1,
        ignoreImages: true,
    });
    async initialise() {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
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
    async getDiscoverSectionItems(section) {
        switch (section.id) {
            case "popular_section":
                return this.getPopularSectionItems(section);
            case "updated_section":
                return this.getUpdatedSectionItems(section);
            default:
                return { items: [] };
        }
    }
    async getAdvancedSearchForm(query) {
        const meta = query.metadata
            ?.searchMeta;
        return new MangacloudSearchForm(meta);
    }
    async getSortingOptions() {
        return SortOptions.map((s) => ({ id: s.id, value: s.name, label: s.name }));
    }
    async getSearchResults(query, metadata, sortingOption) {
        const page = 1;
        const body = { page };
        if (query.title && query.title.trim() !== "") {
            body.title = query.title;
        }
        if (sortingOption && sortingOption.id && sortingOption.id !== "") {
            body.sort = sortingOption.id;
        }
        const searchMeta = query.metadata
            ?.searchMeta;
        const includes = [
            ...(searchMeta?.genreIncluded ?? []),
            ...(searchMeta?.themeIncluded ?? []),
            ...(searchMeta?.formatIncluded ?? []),
        ];
        const excludes = [
            ...(searchMeta?.genreExcluded ?? []),
            ...(searchMeta?.themeExcluded ?? []),
            ...(searchMeta?.formatExcluded ?? []),
        ];
        if (searchMeta?.type)
            body.type = searchMeta.type;
        if (searchMeta?.status)
            body.status = searchMeta.status;
        if (includes.length > 0)
            body.includes = includes;
        if (excludes.length > 0)
            body.excludes = excludes;
        const apiUrl = `https://api.mangacloud.org/comic/library`;
        const request = {
            url: apiUrl,
            method: "POST",
            headers: { "Content-Type": "application/json", accept: "*/*" },
            body: JSON.stringify(body),
        };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const list = resp.data || [];
        const items = [];
        for (const m of list) {
            const mangaId = m.id;
            if (!mangaId)
                continue;
            items.push({
                mangaId,
                title: m.title,
                imageUrl: m.cover
                    ? `https://pika.mangacloud.org/${mangaId}/${m.cover.id}.${m.cover.f}`
                    : "",
                subtitle: undefined,
                metadata: undefined,
            });
        }
        const hasNextPage = list.length > 0;
        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        };
    }
    async getMangaDetails(mangaId) {
        const apiUrl = `https://api.mangacloud.org/comic/${mangaId}`;
        const request = { url: apiUrl, method: "GET" };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const info = resp.data;
        const tagGroups = [];
        if (info.tags && info.tags.length > 0) {
            tagGroups.push({
                id: "tags",
                title: "Tags",
                tags: info.tags.map((t) => ({ id: t.id, title: t.name })),
            });
        }
        const genres = info.tags?.filter((t) => t.type === "genre");
        if (genres && genres.length > 0) {
            tagGroups.push({
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: g.id, title: g.name })),
            });
        }
        return {
            mangaId: mangaId,
            mangaInfo: {
                primaryTitle: info.title,
                secondaryTitles: info.alt_titles ? [info.alt_titles] : [],
                thumbnailUrl: info.cover
                    ? `https://pika.mangacloud.org/${mangaId}/${info.cover.id}.${info.cover.f}`
                    : "",
                synopsis: info.description || "",
                rating: 0,
                contentRating: ContentRating.EVERYONE,
                status: (info.status || "UNKNOWN"),
                tagGroups,
            },
        };
    }
    async getChapters(sourceManga) {
        const mangaId = sourceManga.mangaId;
        const apiUrl = `https://api.mangacloud.org/comic/${mangaId}`;
        const request = { url: apiUrl, method: "GET" };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const info = resp.data;
        const chapters = [];
        if (info.chapters && info.chapters.length > 0) {
            for (const ch of info.chapters) {
                chapters.push({
                    chapterId: ch.id,
                    title: ch.name || `${ch.number}`,
                    sourceManga,
                    chapNum: ch.number,
                    publishDate: ch.created_date ? new Date(ch.created_date) : undefined,
                    volume: 0,
                    langCode: "en",
                    version: "1",
                });
            }
        }
        return chapters;
    }
    async getChapterDetails(chapter) {
        const apiUrl = `https://api.mangacloud.org/chapters/${chapter.chapterId}`;
        const request = { url: apiUrl, method: "GET" };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const info = resp.data;
        const pages = [];
        if (info.images && info.images.length > 0) {
            for (const img of info.images) {
                pages.push(`https://pika.mangacloud.org/${info.comic_id}/${info.id}/${img.id}.${img.f}`);
            }
        }
        return {
            mangaId: chapter.sourceManga.mangaId,
            id: chapter.chapterId,
            pages,
        };
    }
    async getPopularSectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        let apiUrl = `https://api.mangacloud.org/comic-popular-view/today`;
        if (page > 1) {
            apiUrl += `?page=${page}`;
        }
        const request = {
            url: apiUrl,
            method: "GET",
        };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const list = resp.data?.list || [];
        const items = [];
        for (const m of list) {
            const mangaId = m.id;
            if (!mangaId || collectedIds.includes(mangaId))
                continue;
            collectedIds.push(mangaId);
            let coverUrl = "";
            if (m.cover) {
                coverUrl = `https://pika.mangacloud.org/${m.id}/${m.cover.id}.${m.cover.f}`;
            }
            items.push({
                type: "featuredCarouselItem",
                mangaId,
                imageUrl: coverUrl,
                title: m.title,
                supertitle: m.number !== undefined ? `Chapters: ${m.number}` : undefined,
                metadata: undefined,
            });
        }
        const hasNextPage = list.length > 0;
        return {
            items,
            metadata: hasNextPage ? { page: page + 1, collectedIds } : undefined,
        };
    }
    async getUpdatedSectionItems(_section) {
        const page = 1;
        const collectedIds = [];
        const apiUrl = `https://api.mangacloud.org/comic-updates`;
        const request = {
            url: apiUrl,
            method: "POST",
            headers: { "Content-Type": "application/json", accept: "*/*" },
            body: JSON.stringify({ page }),
        };
        const [, data] = await Application.scheduleRequest(request);
        const jsonStr = Application.arrayBufferToUTF8String(data);
        const resp = JSON.parse(jsonStr);
        const list = resp.data?.list || [];
        const items = [];
        for (const m of list) {
            const mangaId = m.id;
            if (!mangaId || collectedIds.includes(mangaId))
                continue;
            collectedIds.push(mangaId);
            let coverUrl = "";
            if (m.cover) {
                coverUrl = `https://pika.mangacloud.org/${m.id}/${m.cover.id}.${m.cover.f}`;
            }
            items.push({
                type: "chapterUpdatesCarouselItem",
                mangaId,
                chapterId: "",
                imageUrl: coverUrl,
                title: m.title,
                subtitle: m.chapters ? `${m.chapters.length} chapters` : undefined,
                metadata: undefined,
            });
        }
        const hasNextPage = list.length > 0;
        return {
            items,
            metadata: hasNextPage ? { page: page + 1, collectedIds } : undefined,
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
    getMangaShareUrl(mangaId) {
        return `${baseUrl}/comic/${mangaId}`;
    }
    checkCloudflareStatus(status) {
        if (status == 503 || status == 403) {
            throw new CloudflareError({ url: baseUrl, method: "GET" });
        }
    }
    async fetchCheerio(request) {
        const [, data] = await Application.scheduleRequest(request);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}
export const Mangacloud = new MangacloudExtension();
