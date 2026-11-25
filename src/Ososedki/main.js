import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import { SearchFilterForm, } from "@paperback/types/lib/compat/0.8/searchFilters";
import * as cheerio from "cheerio";
import { Interceptor, OS_DOMAIN } from "./interceptors";
import pbconfig from "./pbconfig";
const SECTIONS = [
    { id: "new", title: "New Galleries", path: "" },
    { id: "top", title: "Top Galleries", path: "top" },
];
export class OsosedkiExtension {
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    requestManager = new Interceptor("main");
    globalRateLimiter = new BasicRateLimiter("ratelimiter", {
        numberOfRequests: 4,
        bufferInterval: 1,
        ignoreImages: true,
    });
    async initialise() {
        this.cookieStorageInterceptor.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
        this.requestManager.registerInterceptor();
    }
    // ----- Manga -----
    async getMangaDetails(mangaId) {
        const $ = await this.fetchCheerio({
            url: `${OS_DOMAIN}/photos/${mangaId}`,
            method: "GET",
        });
        const pages = this.parseImages($);
        // Photo alt text is "<gallery> - Photo <n>"; strip the photo number.
        const alt = $("figure.photo-item img").first().attr("alt")?.trim() ?? "";
        const titleString = alt.replace(/\s+-\s+Photo\s+\d+$/i, "").trim() ||
            $("h1").first().text().trim() ||
            $('meta[property="og:title"]').attr("content")?.trim() ||
            "";
        const title = decode(titleString);
        // Model / cosplay / fandom buttons above the photo grid
        const tags = [];
        const seen = new Set();
        for (const el of $(".album-info a[href]").toArray()) {
            const id = pathFromUrl($(el).attr("href") ?? "");
            const tagTitle = decode($(el).text().trim());
            if (!id || !tagTitle || seen.has(id))
                continue;
            seen.add(id);
            tags.push({ id, title: tagTitle });
        }
        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: $('meta[property="og:image"]').attr("content") ?? pages[0] ?? "",
                synopsis: `Gallery: ${title}\n\nImages: ${pages.length}`,
                status: "Completed",
                tagGroups: tags.length ? [{ id: "tags", title: "Tags", tags }] : [],
                contentRating: ContentRating.ADULT,
                shareUrl: `${OS_DOMAIN}/photos/${mangaId}`,
            },
        };
    }
    async getChapters(sourceManga) {
        // Galleries have no chapters; expose the whole gallery as one chapter.
        return [
            {
                chapterId: sourceManga.mangaId,
                sourceManga,
                langCode: pbconfig.language,
                chapNum: 1,
                title: "Gallery",
            },
        ];
    }
    async getChapterDetails(chapter) {
        const mangaId = chapter.sourceManga.mangaId;
        const $ = await this.fetchCheerio({
            url: `${OS_DOMAIN}/photos/${chapter.chapterId}`,
            method: "GET",
        });
        return { id: chapter.chapterId, mangaId, pages: this.parseImages($) };
    }
    // ----- Discover -----
    async getDiscoverSections() {
        return SECTIONS.map((s) => ({
            id: s.id,
            title: s.title,
            type: DiscoverSectionType.simpleCarousel,
        }));
    }
    async getDiscoverSectionItems(section, metadata) {
        const def = SECTIONS.find((s) => s.id === section.id);
        if (!def)
            throw new Error(`Invalid section id: ${section.id}`);
        const page = metadata?.page ?? 1;
        const $ = await this.fetchCheerio({
            url: `${OS_DOMAIN}/${def.path}?page=${page}`,
            method: "GET",
        });
        const items = this.parseGalleryList($).map((item) => ({
            type: "simpleCarouselItem",
            mangaId: item.mangaId,
            imageUrl: item.imageUrl,
            title: item.title,
            subtitle: item.subtitle,
        }));
        return {
            items,
            metadata: items.length ? { page: page + 1 } : undefined,
        };
    }
    // ----- Search -----
    async getSearchFilters() {
        const tags = await this.getTags().catch(() => []);
        return [
            {
                id: "category",
                type: "dropdown",
                title: "Category",
                value: "",
                options: [{ id: "", value: "None" }, ...tags.map((t) => ({ id: t.id, value: t.title }))],
            },
        ];
    }
    async getAdvancedSearchForm(query) {
        return new SearchFilterForm(query.metadata, this.getSearchFilters());
    }
    async getSearchResults(query, metadata) {
        const page = metadata?.page ?? 1;
        const title = (query.title ?? "").trim().toLowerCase();
        const category = query.metadata?.find((f) => f.id === "category")?.value;
        let url;
        if (title) {
            url = `${OS_DOMAIN}/search?q=${encodeURIComponent(title)}&page=${page}`;
        }
        else if (typeof category === "string" && category) {
            // Older versions stored bare category slugs
            const path = category.includes("/") ? category : `category/${category}`;
            url = `${OS_DOMAIN}/${path}?page=${page}`;
        }
        else {
            url = `${OS_DOMAIN}/?page=${page}`;
        }
        const $ = await this.fetchCheerio({ url, method: "GET" });
        const items = this.parseGalleryList($);
        return {
            items,
            metadata: items.length ? { page: page + 1 } : undefined,
        };
    }
    async getTags() {
        const $ = await this.fetchCheerio({ url: OS_DOMAIN, method: "GET" });
        const tags = [];
        const seen = new Set();
        for (const el of $('a.dropdown-item[href*="/category/"]').toArray()) {
            const title = $(el).text().trim();
            const id = pathFromUrl($(el).attr("href") ?? "");
            if (!id || !title || seen.has(id))
                continue;
            seen.add(id);
            tags.push({ id, title: decode(title) });
        }
        return tags;
    }
    // ----- Cloudflare -----
    async saveCloudflareBypassCookies(cookies) {
        for (const cookie of this.cookieStorageInterceptor.cookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }
        for (const cookie of cookies) {
            if (cookie.expires && cookie.expires.getTime() <= Date.now())
                continue;
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }
    // ----- Helpers -----
    async fetchCheerio(request) {
        const [response, data] = await Application.scheduleRequest(request);
        await this.checkResponseError(request, response);
        return cheerio.load(Application.arrayBufferToUTF8String(data));
    }
    async checkResponseError(request, response) {
        switch (response.status) {
            case 403:
            case 503:
                throw new CloudflareError({ url: OS_DOMAIN, method: "GET" }, "Cloudflare detected!\nPlease do the Cloudflare bypass to continue!");
            case 404:
                throw new Error(`The requested page ${request.url} was not found!`);
            case 429:
                throw new Error(`Too many requests for ${request.url}!`);
        }
    }
    parseGalleryList($) {
        const results = [];
        const seen = new Set();
        // Ad tiles are div.gallery-item.banner-item; real galleries are <article>s.
        for (const item of $("#gallery article.gallery-item").toArray()) {
            const href = $("a.gallery-link", item).attr("href") ?? "";
            if (!href.includes("/photos/"))
                continue;
            const id = idFromUrl(href);
            if (!id || seen.has(id))
                continue;
            const img = $("img.gallery-img", item).first();
            const title = $("h3", item).first().text().trim() || img.attr("alt")?.trim() || "";
            if (!title)
                continue;
            const count = $(".badge.bg-dark", item).first().text().trim();
            seen.add(id);
            results.push({
                mangaId: id,
                imageUrl: absoluteUrl(img.attr("data-src") ?? img.attr("src") ?? ""),
                title: decode(title),
                subtitle: count ? `${count} images` : undefined,
            });
        }
        return results;
    }
    parseImages($) {
        const pages = [];
        for (const el of $("#photos figure.photo-item").toArray()) {
            const img = $("img", el).first();
            const src = img.attr("data-src") ?? img.attr("src") ?? "";
            const image = absoluteUrl(src && !src.startsWith("data:") ? src : ($("a", el).first().attr("href") ?? ""));
            if (!image || pages.includes(image))
                continue;
            pages.push(image);
        }
        return pages;
    }
}
// ----- Utils -----
function absoluteUrl(url) {
    url = url.trim();
    if (!url)
        return "";
    if (url.startsWith("//"))
        return `https:${url}`;
    if (url.startsWith("/"))
        return OS_DOMAIN + url;
    return url;
}
function decode(str) {
    return Application.decodeHTMLEntities(str);
}
// "https://ososedki.com/model/Foo?x" -> "model/Foo"
function pathFromUrl(url) {
    return url
        .trim()
        .replace(/^https?:\/\/[^/]+/, "")
        .split(/[?#]/)[0]
        .replace(/^\/+|\/+$/g, "");
}
function idFromUrl(url) {
    return url.trim().replace(/\/$/, "").split(/[?#]/)[0].split("/").pop() ?? "";
}
export const Ososedki = new OsosedkiExtension();
