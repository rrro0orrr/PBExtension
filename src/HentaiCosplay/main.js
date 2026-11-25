import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import { SearchFilterForm, } from "@paperback/types/lib/compat/0.8/searchFilters";
import * as cheerio from "cheerio";
import { HC_DOMAIN, Interceptor } from "./interceptors";
import pbconfig from "./pbconfig";
const SECTIONS = [
    { id: "new", title: "New Galleries", path: "search" },
    { id: "top_rated", title: "Most Popular Galleries", path: "ranking" },
    { id: "recently_viewed", title: "Recently Popular", path: "recently" },
];
export class HentaiCosplayExtension {
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
            url: `${HC_DOMAIN}/image/${mangaId}/`,
            method: "GET",
        });
        const title = decode($("span#title > h2").first().text().trim() || $("#title").first().text().trim());
        const image = $("img", "div.icon-overlay").first().attr("src") ??
            $('meta[property="og:image"]').attr("content") ??
            "";
        const tags = [];
        const seen = new Set();
        for (const el of $("a", "p#detail_tag").toArray()) {
            const id = idFromUrl($(el).attr("href") ?? "");
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
                thumbnailUrl: image,
                synopsis: `Gallery: ${title}`,
                status: "Completed",
                tagGroups: tags.length ? [{ id: "tags", title: "Tags", tags }] : [],
                contentRating: ContentRating.ADULT,
                shareUrl: `${HC_DOMAIN}/image/${mangaId}/`,
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
        // The "story" view lists every full-size image of the gallery
        const $ = await this.fetchCheerio({
            url: `${HC_DOMAIN}/story/${mangaId}/`,
            method: "GET",
        });
        const pages = [];
        for (const img of $("amp-story-grid-layer > amp-img").toArray()) {
            const image = $(img).attr("src");
            if (image && !pages.includes(image))
                pages.push(image);
        }
        return { id: chapter.chapterId, mangaId, pages };
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
            url: pagedUrl(def.path, page),
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
            metadata: items.length && this.hasNextPage($, page) ? { page: page + 1 } : undefined,
        };
    }
    // ----- Search -----
    async getSearchFilters() {
        const tags = await this.getTags().catch(() => []);
        if (!tags.length) {
            return [
                {
                    id: "tag",
                    type: "input",
                    title: "Tag",
                    placeholder: "e.g. stockings",
                    value: "",
                },
            ];
        }
        return [
            {
                id: "tag",
                type: "dropdown",
                title: "Tag",
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
        const title = (query.title ?? "").trim();
        const tagValue = query.metadata?.find((f) => f.id === "tag")?.value;
        const tag = typeof tagValue === "string" ? tagValue.trim().toLowerCase().replace(/\s+/g, "-") : "";
        let path;
        if (title) {
            path = `search/keyword/${encodeURIComponent(title)}`;
        }
        else if (tag) {
            path = `search/tag/${encodeURIComponent(tag)}`;
        }
        else {
            path = "search";
        }
        const $ = await this.fetchCheerio({
            url: pagedUrl(path, page),
            method: "GET",
        });
        const items = this.parseGalleryList($);
        return {
            items,
            metadata: items.length && this.hasNextPage($, page) ? { page: page + 1 } : undefined,
        };
    }
    async getTags() {
        const $ = await this.fetchCheerio({
            url: `${HC_DOMAIN}/ranking-tag/`,
            method: "GET",
        });
        const tags = [];
        const seen = new Set();
        for (const el of $('a[href*="/search/tag/"]').toArray()) {
            const id = idFromUrl($(el).attr("href") ?? "");
            const title = decode($(el).text().trim()) || id;
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            tags.push({ id, title });
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
                throw new CloudflareError({ url: HC_DOMAIN, method: "GET" }, "Cloudflare detected!\nPlease do the Cloudflare bypass to continue!");
            case 404:
                throw new Error(`The requested page ${request.url} was not found!`);
            case 429:
                throw new Error(`Too many requests for ${request.url}!`);
        }
    }
    parseGalleryList($) {
        const results = [];
        const seen = new Set();
        for (const item of $("div.image-list-item", "ul#image-list").toArray()) {
            const href = $("a", item).first().attr("href") ?? "";
            // Skip video posts and links to partner sites
            const match = href.match(/\/image\/([^/?#]+)/);
            const id = match?.[1];
            if (!id || seen.has(id))
                continue;
            if (/^https?:\/\//.test(href) && !href.startsWith(HC_DOMAIN))
                continue;
            const title = $("p.image-list-item-title > a", item).text().trim();
            if (!title)
                continue;
            const img = $("img", item).first();
            const image = img.attr("data-original") ?? img.attr("src") ?? "";
            const subtitle = $("p.image-list-item-regist-date > span", item).text().trim();
            seen.add(id);
            results.push({
                mangaId: id,
                imageUrl: image.includes("loading.gif") ? "" : image,
                title: decode(title),
                subtitle: subtitle ? decode(subtitle) : undefined,
            });
        }
        return results;
    }
    hasNextPage($, page) {
        if ($("div.wp-pagenavi a.last, div.wp-pagenavi a.nextpostslink").length > 0) {
            return true;
        }
        return $(`a[href*="/page/${page + 1}/"], a[href$="/page/${page + 1}"]`).length > 0;
    }
}
// ----- Utils -----
function pagedUrl(path, page) {
    return page === 1 ? `${HC_DOMAIN}/${path}/` : `${HC_DOMAIN}/${path}/page/${page}/`;
}
function decode(str) {
    return Application.decodeHTMLEntities(str);
}
function idFromUrl(url) {
    return url.trim().replace(/\/$/, "").split("/").pop() ?? "";
}
export const HentaiCosplay = new HentaiCosplayExtension();
