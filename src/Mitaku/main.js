import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import { SearchFilterForm, } from "@paperback/types/lib/compat/0.8/searchFilters";
import * as cheerio from "cheerio";
import { Interceptor, MITAKU_DOMAIN } from "./interceptors";
import pbconfig from "./pbconfig";
const CATEGORIES = [
    { id: "ero-cosplay", title: "Ero Cosplay" },
    { id: "nude", title: "Nude" },
    { id: "sexy-set", title: "Sexy Set" },
];
export class MitakuExtension {
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    requestManager = new Interceptor("main");
    globalRateLimiter = new BasicRateLimiter("ratelimiter", {
        numberOfRequests: 10,
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
            url: `${MITAKU_DOMAIN}/?p=${mangaId}`,
            method: "GET",
        });
        const images = this.parseImages($);
        const title = decode($(".entry-title").first().text().trim());
        const cosplayer = decode($("p:contains(Cosplayer:)").first().text().replace("Cosplayer:", "").trim());
        const character = decode($("p:contains(Character:)").first().text().replace("Character:", "").trim());
        const synopsisLines = [
            cosplayer ? `Cosplayer: ${cosplayer}` : "",
            character ? `Character: ${character}` : "",
            `Gallery: ${title}`,
            `Images: ${images.length}`,
        ].filter(Boolean);
        const tags = [];
        const seen = new Set();
        for (const el of $('a[rel="tag"], div.genres-content a, .entry-tags a, .tags-links a').toArray()) {
            const href = $(el).attr("href") ?? "";
            const id = idFromUrl(href);
            const tagTitle = decode($(el).text().trim());
            if (!id || !tagTitle || seen.has(id))
                continue;
            seen.add(id);
            tags.push({ id, title: tagTitle });
        }
        const tagGroups = tags.length ? [{ id: "tags", title: "Tags", tags }] : [];
        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: images[0] ?? $('meta[property="og:image"]').attr("content") ?? "",
                author: cosplayer,
                artist: cosplayer,
                synopsis: synopsisLines.join("\n\n"),
                status: "Completed",
                tagGroups,
                contentRating: ContentRating.ADULT,
                shareUrl: `${MITAKU_DOMAIN}/?p=${mangaId}`,
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
            url: `${MITAKU_DOMAIN}/?p=${mangaId}`,
            method: "GET",
        });
        return {
            id: chapter.chapterId,
            mangaId,
            pages: this.parseImages($),
        };
    }
    // ----- Discover -----
    async getDiscoverSections() {
        return [
            {
                id: "latest",
                title: "Latest Galleries",
                type: DiscoverSectionType.simpleCarousel,
            },
            ...CATEGORIES.map((c) => ({
                id: c.id,
                title: `${c.title} Galleries`,
                type: DiscoverSectionType.simpleCarousel,
            })),
        ];
    }
    async getDiscoverSectionItems(section, metadata) {
        const page = metadata?.page ?? 1;
        let path;
        if (section.id === "latest") {
            path = `page/${page}/`;
        }
        else if (CATEGORIES.some((c) => c.id === section.id)) {
            path = `category/${section.id}/page/${page}/`;
        }
        else {
            throw new Error(`Invalid section id: ${section.id}`);
        }
        const $ = await this.fetchCheerio({
            url: `${MITAKU_DOMAIN}/${path}`,
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
            metadata: !this.isLastPage($) ? { page: page + 1 } : undefined,
        };
    }
    // ----- Search -----
    async getSearchFilters() {
        return [
            {
                id: "category",
                type: "dropdown",
                title: "Category",
                value: "all",
                options: [
                    { id: "all", value: "All" },
                    ...CATEGORIES.map((c) => ({ id: c.id, value: c.title })),
                ],
            },
        ];
    }
    async getAdvancedSearchForm(query) {
        return new SearchFilterForm(query.metadata, this.getSearchFilters());
    }
    async getSearchResults(query, metadata) {
        const page = metadata?.page ?? 1;
        const title = sanitizeQuery(query.title ?? "");
        const category = query.metadata?.find((f) => f.id === "category")?.value;
        let url;
        if (title) {
            url = `${MITAKU_DOMAIN}/page/${page}/?s=${encodeURIComponent(title)}`;
        }
        else if (typeof category === "string" && category !== "all") {
            url = `${MITAKU_DOMAIN}/category/${category}/page/${page}/`;
        }
        else {
            url = `${MITAKU_DOMAIN}/page/${page}/`;
        }
        const $ = await this.fetchCheerio({ url, method: "GET" });
        return {
            items: this.parseGalleryList($),
            metadata: !this.isLastPage($) ? { page: page + 1 } : undefined,
        };
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
                throw new CloudflareError({ url: request.url, method: "GET" }, "Cloudflare detected!\nPlease do the Cloudflare bypass to continue!");
            case 404:
                throw new Error(`The requested page ${request.url} was not found!`);
            case 429:
                throw new Error(`Too many requests for ${request.url}!`);
        }
    }
    parseGalleryList($) {
        const results = [];
        const seen = new Set();
        for (const item of $("article").toArray()) {
            const id = ($(item).attr("id") ?? "").split("post-").pop() ?? "";
            if (!id || isNaN(Number(id)) || seen.has(id))
                continue;
            const anchor = $("a", item).first();
            const title = anchor.attr("title")?.trim() || $(".entry-title", item).first().text().trim();
            if (!title)
                continue;
            const subtitle = $('a[rel="tag"]', item)
                .map((_, el) => $(el).text().trim())
                .get()
                .join(", ");
            seen.add(id);
            results.push({
                mangaId: id,
                imageUrl: getImageSrc($("img", item).first()),
                title: decode(title),
                subtitle: subtitle ? decode(subtitle) : undefined,
            });
        }
        return results;
    }
    parseImages($) {
        const pages = [];
        for (const el of $("a", "div.msacwl-slider-wrap").toArray()) {
            const image = $(el).attr("data-mfp-src") ??
                $(el).attr("href") ??
                $(el).attr("data-lazy") ??
                $(el).attr("src");
            if (image && !pages.includes(image))
                pages.push(image);
        }
        // Fallback for posts that use a plain image gallery
        if (!pages.length) {
            for (const el of $("img", ".entry-content").toArray()) {
                const image = getImageSrc($(el));
                if (image && !pages.includes(image))
                    pages.push(image);
            }
        }
        return pages;
    }
    isLastPage($) {
        return ($("a.last, a.nextpostslink, a.next", "div.wp-pagenavi").length === 0 &&
            $("a.next.page-numbers").length === 0);
    }
}
// ----- Utils -----
function decode(str) {
    return Application.decodeHTMLEntities(str);
}
function idFromUrl(url) {
    return url.replace(/\/$/, "").split("/").pop() ?? "";
}
function sanitizeQuery(query) {
    return query
        .replace(/'[^ ]*/g, "")
        .replace(/\.+/g, "")
        .replace(/["']/g, "")
        .trim();
}
function getImageSrc(img) {
    let image;
    for (const attr of ["data-src", "data-lazy-src", "srcset", "src", "data-cfsrc"]) {
        const val = img.attr(attr);
        if (!val || !val.trim())
            continue;
        image = attr === "srcset" ? (val.split(",")[0]?.trim().split(" ")[0] ?? "") : val;
        break;
    }
    if (!image)
        return "";
    image = image.trim().replace(/-\d+x\d+(?=\.\w+$)/, "");
    if (image.startsWith("//"))
        image = `https:${image}`;
    else if (image.startsWith("/"))
        image = MITAKU_DOMAIN + image;
    image = image.replace(/^http:\/\//, "https://");
    return decode(image);
}
export const Mitaku = new MitakuExtension();
