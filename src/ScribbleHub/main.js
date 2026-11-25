import { BasicRateLimiter, CloudflareError, ContentRating, DiscoverSectionType, } from "@paperback/types";
import * as cheerio from "cheerio";
import { render as renderDom } from "dom-serializer";
import * as htmlparser2 from "htmlparser2";
import { ScribbleHubSearchForm } from "./forms/SearchForm";
import { ScribbleHubInterceptor } from "./interceptors";
import { SORTS } from "./model";
const baseUrl = "https://www.scribblehub.com";
export class ScribbleHubExtension {
    requestManager = new ScribbleHubInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 10,
        bufferInterval: 1,
        ignoreImages: true,
    });
    async initialise() {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }
    async getDiscoverSections() {
        return [
            {
                id: "trending_section",
                title: "Trending Novels",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest_section",
                title: "Latest Series",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "latest_updates_section",
                title: "Latest Updates",
                type: DiscoverSectionType.chapterUpdates,
            },
        ];
    }
    async getDiscoverSectionItems(section, metadata) {
        const meta = metadata;
        switch (section.id) {
            case "trending_section":
                return this.getTrendingSectionItems(section, meta);
            case "latest_section":
                return this.getLatestSectionItems(section, meta);
            case "latest_updates_section":
                return this.getLatestUpdatesSectionItems(section, meta);
            default:
                return { items: [] };
        }
    }
    async getSortingOptions(_query) {
        return SORTS.map((s) => ({ id: s.id, label: s.label }));
    }
    async getAdvancedSearchForm(query) {
        const meta = query.metadata?.searchMeta;
        return new ScribbleHubSearchForm(meta);
    }
    async getSearchResults(query, metadata, sortingOption) {
        const paginationMeta = metadata;
        const page = paginationMeta?.page ?? 1;
        const searchMeta = query.metadata
            ?.searchMeta;
        const genres = searchMeta?.genres ?? {};
        const sort = sortingOption?.id ?? "1";
        const included = Object.keys(genres).filter((id) => genres[id] === "included");
        const excluded = Object.keys(genres).filter((id) => genres[id] === "excluded");
        const hasGenreFilter = included.length > 0 || excluded.length > 0;
        let url;
        if (query.title && query.title.trim() !== "") {
            url = `${baseUrl}/?s=${encodeURIComponent(query.title.trim())}&post_type=fictionposts`;
        }
        else if (hasGenreFilter) {
            const parts = [`sf=1`, `sort=${sort}`, `order=1`, `pg=${page}`];
            if (included.length > 0)
                parts.push(`gi=${included.join(",")}`);
            if (excluded.length > 0)
                parts.push(`ge=${excluded.join(",")}`);
            url = `${baseUrl}/series-finder/?${parts.join("&")}`;
        }
        else {
            url = `${baseUrl}/series-ranking/?sort=${sort}&order=1&pg=${page}`;
        }
        const $ = await this.fetchCheerio({ url, method: "GET" });
        const items = await this.parseSearchResults($);
        const hasNextPage = $("a.page-link.next").length > 0;
        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        };
    }
    async getMangaDetails(mangaId) {
        const request = {
            url: `${baseUrl}/series/${mangaId}/`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const title = String($(".fic_title").text()).trim();
        const coverUrl = String($(".fic_image img").attr("src")) || "";
        const genres = [];
        $(".wi_fic_genre a.fic_genre").each((_, el) => {
            genres.push(String($(el).text()).trim());
        });
        const tags = [];
        $(".wi_fic_showtags a.stag").each((_, el) => {
            tags.push(String($(el).text()).trim());
        });
        // Site rating is out of 5; Paperback expects 0..1 (0 when unrated).
        const rawRating = parseFloat(String($(".fic_rate span span").first().text()).trim());
        const rating = isNaN(rawRating) ? 0 : Math.min(Math.max(rawRating / 5, 0), 1);
        const author = String($('[property="author"] .auth_name_fic').text()).trim();
        const rawStatus = String($("li:has(.rnd_stats) > span").text()).trim();
        const statusText = (rawStatus.split(" - ")[0] ?? "").toLowerCase();
        const status = statusText.includes("complet")
            ? "Completed"
            : statusText.includes("ongoing")
                ? "Ongoing"
                : statusText.includes("hiatus")
                    ? "Hiatus"
                    : "Unknown";
        const description = String($(".wi_fic_desc").text()).trim();
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
                author: author || undefined,
                rating: rating,
                contentRating: ContentRating.EVERYONE,
                contentType: "novel",
                status,
                tagGroups: tagGroups,
            },
        };
    }
    async getChapters(sourceManga) {
        const numericId = sourceManga.mangaId.split("/")[0];
        const chapters = [];
        let page = 1;
        while (true) {
            const $ = await this.fetchCheerio({
                url: `${baseUrl}/wp-admin/admin-ajax.php`,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest",
                },
                body: `action=wi_getreleases_pagination&mypostid=${numericId}&pagenum=${page}`,
            });
            const rows = $("li.toc_w");
            if (rows.length === 0)
                break;
            rows.each((_, el) => {
                const li = $(el);
                const a = li.find("a.toc_a");
                const href = String(a.attr("href") ?? "").trim();
                const title = a.text().trim();
                const chapterIdMatch = href.match(/\/(read\/.+\/chapter\/\d+)/);
                const chapterId = chapterIdMatch?.[1] ?? "";
                if (!chapterId)
                    return;
                const chapNum = parseInt(li.attr("order") ?? "0", 10) || 0;
                const dateTitle = String(li.find("span.fic_date_pub").attr("title") ?? "");
                const publishDate = dateTitle && !dateTitle.includes("ago") ? new Date(dateTitle) : undefined;
                chapters.push({
                    chapterId,
                    title,
                    sourceManga,
                    chapNum,
                    publishDate,
                    volume: 0,
                    langCode: "en",
                    version: "1",
                });
            });
            page++;
        }
        return chapters;
    }
    async getChapterDetails(chapter) {
        const request = {
            url: `${baseUrl}/${chapter.chapterId}/`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        $(".wi-ads, .ads-title").remove();
        // Paperback's novel reader parses chapter HTML as XHTML (XML). Raw
        // innerHTML (unclosed <br>, named entities like &nbsp;) fails to parse,
        // so serialize the nodes in XML mode to guarantee well-formed output.
        const content = $(".chp_raw")
            .contents()
            .toArray()
            .map((node) => renderDom(node, { xmlMode: true, decodeEntities: true }))
            .join("")
            .replace(/\u00a0|&#xa0;/g, " ");
        if (!content.trim()) {
            throw new Error(`No content found for chapter ${chapter.chapterId}`);
        }
        const html = `<?xml version="1.0" encoding="UTF-8"?>` +
            `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${content}</body></html>`;
        return {
            mangaId: chapter.sourceManga.mangaId,
            id: chapter.chapterId,
            type: "html",
            html,
        };
    }
    getMangaShareUrl(mangaId) {
        return `${baseUrl}/series/${mangaId}/`;
    }
    async parseSearchResults($) {
        const items = [];
        $(".search_main_box").each((_, el) => {
            const novel = $(el);
            const a = novel.find(".search_title a").first();
            const url = String(a.attr("href") ?? "").trim();
            const title = String(a.text()).trim();
            const imgUrl = String(novel.find(".search_img img").attr("data-src") ?? "") ||
                String(novel.find(".search_img img").attr("src") ?? "");
            const coverUrl = imgUrl.startsWith("http") ? imgUrl : `${baseUrl}${imgUrl}`;
            let mangaId = "";
            const seriesMatch = url.match(/\/series\/(\d+\/[^/?]+)/);
            if (seriesMatch?.[1]) {
                mangaId = seriesMatch[1];
            }
            if (title && mangaId) {
                items.push({ mangaId, title, imageUrl: coverUrl, subtitle: undefined });
            }
        });
        return items;
    }
    async getTrendingSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: `${baseUrl}/series-ranking/?sort=5&order=1&pg=${page}`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        (await this.parseSearchResults($)).forEach((item) => {
            if (!collectedIds.includes(item.mangaId)) {
                collectedIds.push(item.mangaId);
                items.push({
                    type: "featuredCarouselItem",
                    mangaId: item.mangaId,
                    imageUrl: item.imageUrl,
                    title: item.title,
                    supertitle: item.subtitle,
                });
            }
        });
        const hasNextPage = $("a.page-link.next").length > 0;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    async getLatestUpdatesSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: `${baseUrl}/latest-series/?pg=${page}`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        (await this.parseSearchResults($)).forEach((item) => {
            if (!collectedIds.includes(item.mangaId)) {
                collectedIds.push(item.mangaId);
                items.push({
                    type: "chapterUpdatesCarouselItem",
                    mangaId: item.mangaId,
                    chapterId: "",
                    imageUrl: item.imageUrl,
                    title: item.title,
                    subtitle: item.subtitle,
                });
            }
        });
        const hasNextPage = $("a.page-link.next").length > 0;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    async getLatestSectionItems(_section, metadata) {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];
        const request = {
            url: `${baseUrl}/latest-series/?pg=${page}`,
            method: "GET",
        };
        const $ = await this.fetchCheerio(request);
        const items = [];
        (await this.parseSearchResults($)).forEach((item) => {
            if (!collectedIds.includes(item.mangaId)) {
                collectedIds.push(item.mangaId);
                items.push({
                    type: "simpleCarouselItem",
                    mangaId: item.mangaId,
                    imageUrl: item.imageUrl,
                    title: item.title,
                    subtitle: item.subtitle,
                });
            }
        });
        const hasNextPage = $("a.page-link.next").length > 0;
        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }
    checkCloudflareStatus(status) {
        if (status == 503 || status == 403) {
            throw new CloudflareError({ url: baseUrl, method: "GET" });
        }
    }
    async fetchCheerio(request) {
        const [, data] = await Application.scheduleRequest(request);
        this.checkCloudflareStatus(data?.status ?? 200);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}
export const ScribbleHub = new ScribbleHubExtension();
