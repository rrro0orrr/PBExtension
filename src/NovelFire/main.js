import { BasicRateLimiter, CloudflareError, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import * as cheerio from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { URLBuilder } from "../utils/url-builder/base";
import { DEFAULT_SEARCH_META, NovelFireSearchForm } from "./forms/SearchForm";
import { NovelFireInterceptor } from "./interceptors";
import { SORTS, } from "./model";
// novelfire.net now redirects to this mirror, which uses /novel/ instead of /book/.
const baseUrl = "https://novelphoenix.com";
// Cloudflare answers bursts with HTTP 429 ("Access denied", error 1015), so back off and retry.
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_SECONDS = 30;
const MAX_CHAPTER_PAGES = 200;
const FALLBACK_COVER = `${baseUrl}/favicon.ico`;
const VOID_ELEMENTS = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";
const VOID_ELEMENT_REGEX = new RegExp(`<(${VOID_ELEMENTS})((?:\\s+[^>]*?)?)\\s*/?>`, "gi");
// Turns every void element into a self-closing tag so the chapter is valid XHTML for Readium.
function fixVoidElements(html) {
    return html.replace(VOID_ELEMENT_REGEX, (_match, tag, attributes) => {
        const attrs = attributes.trim();
        return attrs ? `<${tag.toLowerCase()} ${attrs} />` : `<${tag.toLowerCase()} />`;
    });
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
// Accepts "/book/slug", "/novel/slug/chapter-1" or a full URL on any mirror domain
// and returns just "slug" or "slug/chapter-1".
function toId(href) {
    const match = href.match(/\/(?:book|novel)\/([^?#]+)/);
    return (match?.[1] ?? href).replace(/^\/+|\/+$/g, "");
}
// Resolves relative or protocol-less image paths against the site.
function absoluteUrl(path) {
    if (!path)
        return "";
    if (/^https?:\/\//i.test(path))
        return path;
    if (path.startsWith("//"))
        return `https:${path}`;
    return path.startsWith("/") ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
}
// The site prints "2026-11-19 14:52[:07]" with no timezone. Parse it as UTC and never
// return a date in the future: Paperback traps (crashes) formatting a Date range when a
// chapter's publish date is later than "now", which happens for freshly posted chapters
// when the string is read as device-local time.
function parseSiteDate(text) {
    const m = text?.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m)
        return undefined;
    const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    if (Number.isNaN(time))
        return undefined;
    return new Date(Math.min(time, Date.now()));
}
// "4 weeks ago", "an hour ago", "yesterday", "just now" -> approximate Date (never in the future)
function parseRelativeDate(text) {
    const t = text?.trim().toLowerCase();
    if (!t)
        return undefined;
    if (t === "just now" || t === "now")
        return new Date();
    if (t === "yesterday")
        return new Date(Date.now() - 86_400_000);
    const m = t.match(/^(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
    if (!m)
        return undefined;
    const n = m[1] === "a" || m[1] === "an" ? 1 : parseInt(m[1], 10);
    const unitMs = {
        second: 1_000,
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
        week: 604_800_000,
        month: 2_592_000_000,
        year: 31_536_000_000,
    };
    return new Date(Date.now() - n * unitMs[m[2]]);
}
function mapStatus(label) {
    switch (label.trim().toLowerCase()) {
        case "ongoing":
            return "Ongoing";
        case "completed":
            return "Completed";
        case "hiatus":
            return "Hiatus";
        case "dropped":
        case "cancelled":
            return "Dropped";
        default:
            return "Unknown";
    }
}
const ADULT_GENRES = ["adult", "smut", "ecchi", "hentai", "yaoi", "yuri", "mature"];
function mapContentRating(genres) {
    const lower = genres.map((g) => g.toLowerCase());
    if (lower.some((g) => g === "adult" || g === "smut" || g === "hentai"))
        return ContentRating.ADULT;
    if (lower.some((g) => ADULT_GENRES.includes(g)))
        return ContentRating.MATURE;
    return ContentRating.EVERYONE;
}
export class NovelFireExtension {
    requestManager = new NovelFireInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 2,
        bufferInterval: 1,
        ignoreImages: true,
    });
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    async initialise() {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
    }
    async cloudflareBypassCompleted(_request, cookies, _localStorage) {
        for (const cookie of cookies) {
            if (cookie.expires && cookie.expires.getTime() <= Date.now())
                continue;
            if (cookie.name.startsWith("cf") ||
                cookie.name.startsWith("_cf") ||
                cookie.name.startsWith("__cf")) {
                this.cookieStorageInterceptor.setCookie(cookie);
            }
        }
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
            {
                id: "new_section",
                title: "New Novels",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }
    async getDiscoverSectionItems(section, metadata) {
        const meta = metadata;
        switch (section.id) {
            case "popular_section":
                return this.getPopularSectionItems(section, meta);
            case "updated_section":
                return this.getUpdatedSectionItems(section, meta);
            case "new_section":
                return this.getNewSectionItems(section, meta);
            default:
                return { items: [] };
        }
    }
    async getSortingOptions(_query) {
        return SORTS.map((s) => ({ id: s.id, label: s.label }));
    }
    async getAdvancedSearchForm(query) {
        const meta = query.metadata?.searchMeta;
        return new NovelFireSearchForm(meta);
    }
    async getSearchResults(query, metadata, sortingOption) {
        const paginationMeta = metadata;
        const page = paginationMeta?.page ?? 1;
        if (query.title && query.title.trim() !== "") {
            const searchUrl = `${baseUrl}/ajax/searchLive?keyword=${encodeURIComponent(query.title.trim())}&type=title`;
            const [, data] = await this.scheduleRequest({ url: searchUrl, method: "GET" });
            const jsonString = Application.arrayBufferToUTF8String(data);
            const result = JSON.parse(jsonString);
            const items = (result?.data ?? []).map((item) => ({
                mangaId: item.slug,
                title: item.title,
                imageUrl: absoluteUrl(item.image) || `${baseUrl}/server-1/${item.slug}.jpg`,
                subtitle: `${item.total_chapter} chapters`,
            }));
            return { items };
        }
        const searchMeta = {
            ...DEFAULT_SEARCH_META,
            ...query.metadata?.searchMeta,
        };
        const [tagIds, excludedTagIds] = await Promise.all([
            this.resolveTagIds(searchMeta.tags),
            this.resolveTagIds(searchMeta.excludedTags),
        ]);
        // Same query string the site's /search-adv form submits
        const params = [
            ...searchMeta.languages.map((id) => ["country_id[]", id]),
            ["ctgcon", searchMeta.genreMatch],
            ...searchMeta.genres.map((id) => ["categories[]", id]),
            ["totalchapter", searchMeta.chapters],
            ["ratcon", searchMeta.ratingMatch],
            ["rating", searchMeta.rating],
            ["status", searchMeta.status],
            ["sort", sortingOption?.id ?? "date"],
            ["tagcon", searchMeta.tagMatch],
            ...tagIds.map((id) => ["tags[]", id]),
            ...excludedTagIds.map((id) => ["tags_excluded[]", id]),
            ["page", String(page)],
        ];
        const queryString = params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join("&");
        const $ = await this.fetchCheerio({
            url: `${baseUrl}/search-adv?${queryString}`,
            method: "GET",
        });
        const collectedIds = [];
        const items = [];
        $(".novel-item").each((_, el) => {
            const novel = $(el);
            const link = novel.find(".novel-title a").first();
            const a = link.length ? link : novel.find("a").first();
            const url = a.attr("href") || "";
            const title = (a.attr("title") || a.text()).trim();
            const img = novel.find("img").first();
            const coverUrl = absoluteUrl(img.attr("data-src") || img.attr("src")) || FALLBACK_COVER;
            const mangaId = toId(url);
            if (title && mangaId && !collectedIds.includes(mangaId)) {
                collectedIds.push(mangaId);
                items.push({ mangaId, title, imageUrl: coverUrl, subtitle: undefined });
            }
        });
        const hasNextPage = !!$('a[rel="next"]').length ||
            !!$(".pagination .page-item.active + .page-item:not(.disabled)").length;
        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        };
    }
    async getMangaDetails(mangaId) {
        const request = {
            url: new URLBuilder(baseUrl).addPath("novel").addPath(mangaId).build(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const cover = $(".cover img, figure.cover img, .novel-cover img, .fixed-img img").first();
        const title = $(".novel-title").first().text().trim() || (cover.attr("alt") ?? "").trim();
        // Paperback rejects an empty thumbnailUrl ("Invalid URL"), so fall back through
        // lazy-load attributes, the og:image meta tag and finally the site's favicon.
        const coverUrl = absoluteUrl(cover.attr("data-src") ||
            cover.attr("data-original") ||
            cover.attr("src") ||
            $('meta[property="og:image"]').attr("content") ||
            $('meta[name="twitter:image"]').attr("content")) || FALLBACK_COVER;
        const genres = [];
        $(".categories .property-item").each((_, el) => {
            const genre = $(el).text().trim();
            if (genre)
                genres.push(genre);
        });
        const tags = [];
        $(".tag").each((_, el) => {
            const tag = $(el).text().trim();
            if (tag)
                tags.push(tag);
        });
        const author = $(".author .property-item > span").first().text().trim();
        const status = mapStatus($(".header-stats .ongoing").first().text() ||
            $(".header-stats .completed").first().text() ||
            "");
        const rating = parseFloat($(".nub").first().text().trim());
        const summary = $(".summary .content").first();
        summary.find(".expand").remove();
        const description = Application.decodeHTMLEntities(summary.text().trim());
        const tagGroups = [];
        if (genres.length > 0) {
            tagGroups.push({
                id: "genres",
                title: "Genres",
                tags: genres.map((genre) => ({
                    id: genre.toLowerCase().replace(/\s+/g, "-"),
                    title: genre,
                })),
            });
        }
        if (tags.length > 0) {
            tagGroups.push({
                id: "tags",
                title: "Tags",
                tags: tags.map((tag) => ({
                    id: tag.toLowerCase().replace(/\s+/g, "-"),
                    title: tag,
                })),
            });
        }
        return {
            mangaId: mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: coverUrl,
                synopsis: description,
                ...(Number.isFinite(rating) ? { rating } : {}),
                ...(author ? { author } : {}),
                contentRating: mapContentRating(genres),
                contentType: "novel",
                status,
                tagGroups,
                shareUrl: this.getMangaShareUrl(mangaId),
            },
        };
    }
    async getChapters(sourceManga) {
        const mangaId = sourceManga.mangaId;
        const chapters = [];
        const seenIds = new Set();
        let page = 1;
        while (page <= MAX_CHAPTER_PAGES) {
            const request = {
                url: new URLBuilder(baseUrl)
                    .addPath("novel")
                    .addPath(mangaId)
                    .addPath("chapters")
                    .addQuery("page", String(page))
                    .build(),
                method: "GET",
            };
            const $ = await this.fetchCheerio(request);
            const items = $(".chapter-list li");
            if (items.length === 0)
                break;
            let added = 0;
            items.each((_, el) => {
                const a = $(el).find("a").first();
                const href = a.attr("href") ?? "";
                if (!href)
                    return;
                const chapterId = toId(href);
                if (seenIds.has(chapterId))
                    return;
                seenIds.add(chapterId);
                added++;
                // novelfire.net: title attr "Chapter 1: Name", chapter-no "1", absolute datetime.
                // novelphoenix.com: no title attr, chapter-no "Ch. 1", relative "4 weeks ago".
                const title = (a.attr("title") ||
                    a.find(".chapter-title").first().text() ||
                    a.text()).trim();
                const noMatch = a
                    .find(".chapter-no")
                    .text()
                    .match(/\d+(?:\.\d+)?/) ?? href.match(/chapter-(\d+(?:\.\d+)?)/);
                const parsedNo = noMatch ? parseFloat(noMatch[1] ?? noMatch[0]) : NaN;
                const time = a.find("time").first();
                const publishDate = parseSiteDate(time.attr("datetime")) ?? parseRelativeDate(time.text());
                chapters.push({
                    chapterId,
                    title,
                    sourceManga,
                    // Fall back to the chapter's position so sorting and read tracking still work
                    chapNum: Number.isFinite(parsedNo) ? parsedNo : chapters.length + 1,
                    ...(publishDate ? { publishDate } : {}),
                    volume: 0,
                    langCode: "en",
                    version: "1",
                });
            });
            // Stop if the site keeps serving the same page, otherwise this loop hammers it into a 429
            // The mirror pages with a range dropdown ("1-100", "101-200", ...) instead of .pagination
            const lastPage = Math.max(0, ...$(".chapter-range-pager option, .chapter-range-pager a")
                .map((_, el) => Number(($(el).attr("value") ?? $(el).attr("href") ?? "").match(/[?&]page=(\d+)/)?.[1] ?? 0))
                .get());
            const hasNextPage = lastPage > 0
                ? page < lastPage
                : !!$(".pagination .page-item.active + .page-item:not(.disabled)").length;
            if (!hasNextPage || added === 0)
                break;
            page++;
        }
        return chapters;
    }
    async getChapterDetails(chapter) {
        let url = new URLBuilder(baseUrl).addPath("novel").addPath(chapter.chapterId).build();
        const trail = [];
        // The site may answer with a redirect page (meta refresh / JS) pointing to a mirror
        // domain that has the real text, so follow up to 3 hops.
        for (let hop = 0; hop < 3; hop++) {
            const page = await this.fetchPage({ url, method: "GET" });
            const content = this.extractChapterText(page.$);
            if (content !== "") {
                const heading = chapter.title ? `<h2>${escapeHtml(chapter.title)}</h2>` : "";
                // Readium parses chapters as XHTML, so bare void tags like <br> must be self-closed
                const body = fixVoidElements(heading + "\n" + content);
                const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body}</body></html>`;
                return {
                    mangaId: chapter.sourceManga.mangaId,
                    id: chapter.chapterId,
                    type: "html",
                    html,
                };
            }
            const title = page.$("title").first().text().trim().slice(0, 80);
            trail.push(`${url} -> ${page.finalUrl} [HTTP ${page.status}] "${title}"`);
            const next = this.findRedirectTarget(page.$, page.html, page.finalUrl);
            if (!next || next === url)
                break;
            url = next;
        }
        // Throw instead of returning an empty page so the reader shows an error, not a blank screen
        throw new Error(`NovelFire: no chapter text found. Tried: ${trail.join(" | ")}`);
    }
    extractChapterText($) {
        $(".nf-ads, .ads, .adsbygoogle, script, style, iframe, ins, noscript").remove();
        for (const selector of [
            "#content",
            "#chapter-container",
            ".chapter-content",
            "#chapter-content",
            ".chapter-body",
        ]) {
            const node = $(selector).first();
            if (node.length === 0 || node.text().trim() === "")
                continue;
            return (node.html() ?? "").replace(/&nbsp;/g, " ").trim();
        }
        return "";
    }
    findRedirectTarget($, html, currentUrl) {
        const refresh = $("meta[http-equiv]")
            .filter((_, el) => ($(el).attr("http-equiv") ?? "").toLowerCase() === "refresh")
            .attr("content");
        const fromMeta = refresh?.match(/url\s*=\s*['"]?([^'";\s]+)/i)?.[1];
        const fromScript = html.match(/(?:window\.|document\.|top\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*['"]([^'"]+)['"]/)?.[1];
        const target = (fromMeta ?? fromScript)?.replace(/\\\//g, "/");
        if (!target || target.startsWith("#") || /^\s*(?:javascript|data|vbscript):/i.test(target)) {
            return undefined;
        }
        if (/^https?:\/\//i.test(target))
            return target;
        const origin = currentUrl.match(/^(https?:\/\/[^/]+)/i)?.[1] ?? baseUrl;
        return target.startsWith("/") ? `${origin}${target}` : `${origin}/${target}`;
    }
    // Turns "Weak to Strong, Cultivation" into the site's tag IDs via its autocomplete endpoint.
    async resolveTagIds(names) {
        const ids = [];
        for (const name of names
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)) {
            const [, data] = await this.scheduleRequest({
                url: `${baseUrl}/ajax/getTags?term=${encodeURIComponent(name)}`,
                method: "GET",
            });
            let tags = [];
            try {
                tags =
                    JSON.parse(Application.arrayBufferToUTF8String(data)).data ?? [];
            }
            catch {
                continue;
            }
            const match = tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? tags[0];
            if (match && !ids.includes(String(match.id)))
                ids.push(String(match.id));
        }
        return ids;
    }
    getMangaShareUrl(mangaId) {
        return `${baseUrl}/novel/${mangaId}`;
    }
    async getPopularSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: new URLBuilder(baseUrl)
                .addPath("genre-all")
                .addPath("sort-popular")
                .addPath("status-all")
                .addPath("all-novel")
                .addQuery("page", page.toString())
                .build(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        $(".novel-item").each((_, el) => {
            const novel = $(el);
            const a = novel.find("a");
            const url = a.attr("href") || "";
            const title = a.attr("title") || "";
            const imgurl = novel.find("img").attr("data-src") || novel.find("img").attr("src") || "";
            const coverUrl = absoluteUrl(imgurl) || FALLBACK_COVER;
            const rating = parseFloat(novel.find(".badge._br").text().trim()) || undefined;
            const mangaId = toId(url);
            if (title && mangaId && !collectedIds.includes(mangaId)) {
                collectedIds.push(mangaId);
                items.push({
                    type: "featuredCarouselItem",
                    mangaId: mangaId,
                    imageUrl: coverUrl,
                    title: title,
                    supertitle: rating ? `⭐ ${rating}` : undefined,
                });
            }
        });
        const hasNextPage = !!$(".pagination .page-item.active + .page-item").length;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    async getUpdatedSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: new URLBuilder(baseUrl)
                .addPath("genre-all")
                .addPath("sort-latest-release")
                .addPath("status-all")
                .addPath("all-novel")
                .addQuery("page", page.toString())
                .build(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        $(".novel-item").each((_, el) => {
            const novel = $(el);
            const a = novel.find("a");
            const url = a.attr("href") || "";
            const title = a.attr("title") || "";
            const imgurl = novel.find("img").attr("data-src") || novel.find("img").attr("src") || "";
            const coverUrl = absoluteUrl(imgurl) || FALLBACK_COVER;
            const chapters = parseInt(novel.find(".novel-stats").text().replace(/\D/g, "")) || undefined;
            const mangaId = toId(url);
            if (title && mangaId && !collectedIds.includes(mangaId)) {
                collectedIds.push(mangaId);
                items.push({
                    type: "chapterUpdatesCarouselItem",
                    mangaId: mangaId,
                    chapterId: "",
                    imageUrl: coverUrl,
                    title: title,
                    subtitle: chapters ? `${chapters} chapters` : undefined,
                });
            }
        });
        const hasNextPage = !!$(".pagination .page-item.active + .page-item").length;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    async getNewSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: new URLBuilder(baseUrl)
                .addPath("genre-all")
                .addPath("sort-new")
                .addPath("status-all")
                .addPath("all-novel")
                .addQuery("page", page.toString())
                .build(),
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        $(".novel-item").each((_, el) => {
            const novel = $(el);
            const a = novel.find("a");
            const url = a.attr("href") || "";
            const title = a.attr("title") || "";
            const imgurl = novel.find("img").attr("data-src") || novel.find("img").attr("src") || "";
            const coverUrl = absoluteUrl(imgurl) || FALLBACK_COVER;
            const rating = parseFloat(novel.find(".badge._br").text().trim()) || undefined;
            const mangaId = toId(url);
            if (title && mangaId && !collectedIds.includes(mangaId)) {
                collectedIds.push(mangaId);
                items.push({
                    type: "simpleCarouselItem",
                    mangaId: mangaId,
                    imageUrl: coverUrl,
                    title: title,
                    subtitle: rating ? `⭐ ${rating}` : undefined,
                });
            }
        });
        const hasNextPage = !!$(".pagination .page-item.active + .page-item").length;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    // Wraps Application.scheduleRequest and retries on HTTP 429, honouring Retry-After when present.
    async scheduleRequest(request) {
        for (let attempt = 0;; attempt++) {
            const [response, data] = await Application.scheduleRequest(request);
            if (response.status !== 429)
                return [response, data];
            if (attempt >= MAX_RATE_LIMIT_RETRIES) {
                throw new Error("NovelFire: the site is rate-limiting requests (HTTP 429). Wait a minute and try again.");
            }
            const retryAfter = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
            const parsed = parseInt(retryAfter ?? "", 10);
            const wait = Number.isFinite(parsed) && parsed > 0 ? parsed : 2 ** (attempt + 1);
            await Application.sleep(Math.min(wait, MAX_RETRY_WAIT_SECONDS));
        }
    }
    // Chapter pages redirect to mirror domains (e.g. novelphoenix.com), so point the bypass
    // at the domain that actually challenged us; clearing novelfire.net wouldn't help.
    checkCloudflareStatus(status, url = baseUrl) {
        if (status == 503 || status == 403) {
            const origin = url.match(/^https?:\/\/[^/?#]+/i)?.[0] ?? baseUrl;
            throw new CloudflareError({ url: origin, method: "GET" });
        }
    }
    async fetchPage(request) {
        const [response, data] = await this.scheduleRequest(request);
        this.checkCloudflareStatus(response.status, response.url || request.url);
        const html = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(html);
        return {
            $: cheerio.load(dom),
            html,
            finalUrl: response.url || request.url,
            status: response.status,
        };
    }
    async fetchCheerio(request) {
        const [response, data] = await this.scheduleRequest(request);
        this.checkCloudflareStatus(response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}
export const NovelFire = new NovelFireExtension();
