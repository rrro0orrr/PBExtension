import {
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  CloudflareError,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  DiscoverSectionType,
  Extension,
  MangaProviding,
  Metadata,
  PagedResults,
  PaperbackInterceptor,
  Request,
  Response,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SourceManga,
  TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

// Ported from Nicartjay/PaperbackExt (MIT), itself converted from keiyoushi.

const BASE_URL = "https://doujins.com";

const PAGE_DAYS = 3;

interface DoujinsMetadata {
  page?: number;
}

interface DoujinsSearchMeta {
  series?: string;
  sort?: string;
  period?: string;
}

// Mirrors the upstream SeriesFilter options (display label -> path).
const SERIES_OPTIONS: { title: string; path: string }[] = [
  { title: "Doujins - Original Series", path: "/doujins-original-series-19934" },
  { title: "Hentai Magazine Chapters", path: "/hentai-magazine-chapters-2766" },
  { title: "Hentai Manga", path: "/hentai-manga-19" },
  { title: "Fate Grand Order", path: "/fate-grand-order-doujins-28615" },
  { title: "CG Sets - Original Series", path: "/cg-sets-original-series-14865" },
  { title: "Touhou", path: "/touhou-doujins-7748" },
  { title: "Naruto", path: "/naruto-doujins-5761" },
  { title: "Kantai Collection", path: "/kantai-collection-doujins-22720" },
  { title: "Hentai Game CG-Sets", path: "/hentai-game-cg-sets-2422" },
  { title: "One Piece", path: "/one-piece-doujins-6080" },
  { title: "Granblue Fantasy", path: "/granblue-fantasy-doujins-28177" },
  { title: "Azur Lane", path: "/azur-lane-doujins-34298" },
  { title: "Sword Art Online", path: "/sword-art-online-doujins-7246" },
  { title: "Idolmaster", path: "/idolmaster-4281" },
  { title: "My Hero Academia", path: "/my-hero-academia-doujins-28744" },
  { title: "Love Live", path: "/love-live-doujins-21865" },
  { title: "Pokemon", path: "/pokemon-doujins-6393" },
  { title: "Dragon Ball", path: "/dragon-ball-doujins-1238" },
  { title: "CGs - Mixed Series", path: "/cgs-mixed-series-35311" },
  { title: "Doujins - Mixed Series", path: "/doujins-mixed-series-20091" },
  {
    title: "Hentai Magazine Chapters - Super-Shorts",
    path: "/hentai-magazine-chapters-super-shorts-19933",
  },
];

// Period browsing (PopularityPeriodFilter).
const PERIOD_OPTIONS: { title: string; path: string }[] = [
  { title: "Popular - This Month", path: "/top/month" },
  { title: "Popular - This Year", path: "/top/year" },
  { title: "Popular - All Time", path: "/top/all" },
];

class DoujinsInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      referer: `${BASE_URL}/`,
      origin: BASE_URL,
      "user-agent": await Application.getDefaultUserAgent(),
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.5",
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
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

type DoujinsImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  CloudflareBypassRequestProviding &
  DiscoverSectionProviding;

export class DoujinsExtension implements DoujinsImplementation {
  requestManager = new DoujinsInterceptor("main");
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 2,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.requestManager.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----------------------------------------------------------------
  // Discover sections
  // ----------------------------------------------------------------

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "popular",
        title: "Popular This Month",
        type: DiscoverSectionType.featured,
      },
      {
        id: "latest",
        title: "Latest Updates",
        type: DiscoverSectionType.simpleCarousel,
      },
      {
        id: "series",
        title: "Browse Series",
        type: DiscoverSectionType.genres,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "series") {
      const items: DiscoverSectionItem[] = [
        ...SERIES_OPTIONS.map((opt) => ({
          type: "genresCarouselItem" as const,
          searchQuery: {
            title: "",
            metadata: { series: opt.path } as Metadata,
          },
          name: opt.title,
          metadata: undefined,
        })),
        ...PERIOD_OPTIONS.map((opt) => ({
          type: "genresCarouselItem" as const,
          searchQuery: {
            title: "",
            metadata: { period: opt.path } as Metadata,
          },
          name: opt.title,
          metadata: undefined,
        })),
      ];
      return { items, metadata: undefined };
    }

    if (section.id === "latest") {
      const meta = metadata as DoujinsMetadata | undefined;
      const page = meta?.page ?? 1;
      const url = this.latestPageUrl(page);
      const [, data] = await Application.scheduleRequest({ url, method: "GET" });
      const json = JSON.parse(Application.arrayBufferToUTF8String(data)) as {
        folders?: unknown;
      };
      const folders = Array.isArray(json.folders) ? json.folders : [];

      const items: DiscoverSectionItem[] = [];
      const seen = new Set<string>();
      for (const raw of folders) {
        const folder = raw as Record<string, unknown>;
        const link = typeof folder.link === "string" ? folder.link : "";
        if (!link) continue;
        const mangaId = this.parsePath(link);
        if (!mangaId || seen.has(mangaId)) continue;
        seen.add(mangaId);
        const title = typeof folder.name === "string" ? folder.name : this.safeDecode(mangaId);
        const thumb = typeof folder.thumbnail2 === "string" ? folder.thumbnail2 : "";
        items.push({
          type: "simpleCarouselItem",
          mangaId,
          imageUrl: this.absoluteUrl(thumb),
          title,
          metadata: undefined,
        });
      }
      return {
        items,
        metadata: items.length > 0 ? { page: page + 1 } : undefined,
      };
    }

    // popular
    const url = `${BASE_URL}/top/month`;
    const $ = await this.fetchCheerio({ url, method: "GET" });
    const { items: parsed } = this.parseGalleryPage($);
    const items: DiscoverSectionItem[] = parsed.map((p) => ({
      type: "featuredCarouselItem",
      mangaId: p.mangaId,
      imageUrl: p.imageUrl,
      title: p.title,
      metadata: undefined,
    }));
    return { items, metadata: undefined };
  }

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const meta = metadata as DoujinsMetadata | undefined;
    const page = meta?.page ?? 1;
    const titleQuery = (query.title || "").trim();

    const searchMeta = query.metadata as DoujinsSearchMeta | undefined;
    const sort = searchMeta?.sort ?? "";

    let url: string;
    if (titleQuery !== "") {
      const params = [`words=${encodeURIComponent(titleQuery)}`, `page=${page}`];
      if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
      url = `${BASE_URL}/searches?${params.join("&")}`;
    } else if (searchMeta?.series) {
      // Series listings paginate with ?page=N
      const params = [`page=${page}`];
      if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
      url = `${BASE_URL}${searchMeta.series}?${params.join("&")}`;
    } else {
      url = `${BASE_URL}${searchMeta?.period ?? "/top/month"}`;
    }

    const $ = await this.fetchCheerio({ url, method: "GET" });
    const { items, hasNextPage } = this.parseGalleryPage($);

    const results: SearchResultItem[] = items.map((p) => ({
      mangaId: p.mangaId,
      imageUrl: p.imageUrl,
      title: p.title,
      subtitle: p.subtitle,
      metadata: undefined,
    }));

    return {
      items: results,
      metadata: hasNextPage ? { page: page + 1 } : undefined,
    };
  }

  private parseGalleryPage($: CheerioAPI): {
    items: {
      mangaId: string;
      imageUrl: string;
      title: string;
      subtitle?: string;
    }[];
    hasNextPage: boolean;
  } {
    const items: {
      mangaId: string;
      imageUrl: string;
      title: string;
      subtitle?: string;
    }[] = [];
    const seen = new Set<string>();

    $("div:not(.premium-folder) > .thumbnail-doujin a.gallery-visited-from-favorites").each(
      (_, element) => {
        const el = $(element);
        const href = el.attr("href") || "";
        if (!href) return;
        const mangaId = this.parsePath(href);
        if (!mangaId || seen.has(mangaId)) return;
        seen.add(mangaId);

        const title = el.find("div.title .text").text().trim();
        const imageUrl = this.absoluteUrl(
          el.find("img").attr("srcset") || el.find("img").attr("src") || "",
        );

        const artist = el.parent().next().find(".single-line strong").last().text().trim();
        const subtitle = artist ? artist.replace(/^Artist:\s*/i, "").trim() : undefined;

        items.push({ mangaId, imageUrl, title, subtitle });
      },
    );

    const pagination = $(".pagination").first();
    let hasNextPage = false;
    if (pagination.length > 0) {
      hasNextPage = !pagination.find("li.page-item:last-child").hasClass("disabled");
    }

    return { items, hasNextPage };
  }

  // ----------------------------------------------------------------
  // Manga details
  // ----------------------------------------------------------------

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = this.mangaUrl(mangaId);
    const $ = await this.fetchCheerio({ url, method: "GET" });

    const title = $(".folder-title a").last().text().trim() || this.safeDecode(mangaId);
    const artist = $(".gallery-artist a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((a) => a.length > 0)
      .join(", ");

    const genres = $(".tag-area")
      .first()
      .find("a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((g) => g.length > 0);

    const thumbnailUrl = this.imageFromElement($(".gallery-image img, .doujin").first());

    const tagGroups: TagSection[] = [];
    if (genres.length > 0) {
      tagGroups.push({
        id: "genres",
        title: "Tags",
        tags: genres.map((g) => ({
          id: g.toLowerCase().replace(/\s+/g, "-"),
          title: g,
        })),
      });
    }

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl,
        author: artist || undefined,
        artist: artist || undefined,
        synopsis: "",
        contentRating: ContentRating.ADULT,
        status: "Completed",
        tagGroups,
        shareUrl: url,
      },
    };
  }

  // ----------------------------------------------------------------
  // Chapters
  // ----------------------------------------------------------------

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const url = this.mangaUrl(sourceManga.mangaId);
    const $ = await this.fetchCheerio({ url, method: "GET" });

    const dateAndPageCount = $(".text-md-right.text-sm-left > .folder-message").text().trim();
    const dateStr = dateAndPageCount.split(" • ")[0]?.trim() || "";
    const publishDate = this.parseDate(dateStr);

    // Each gallery/folder is a single "chapter"; the chapter id is the
    // gallery url itself (matching the upstream chapterListParse).
    return [
      {
        chapterId: sourceManga.mangaId,
        sourceManga,
        title: "Chapter",
        volume: 0,
        chapNum: 1,
        publishDate,
        langCode: "🇬🇧",
      },
    ];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const url = this.chapterUrl(chapter.chapterId);
    const $ = await this.fetchCheerio({ url, method: "GET" });

    const pages: string[] = [];
    $(".doujin").each((_, element) => {
      const file = ($(element).attr("data-file") || "").replace(/amp;/g, "");
      if (file) pages.push(this.absoluteUrl(file));
    });

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    };
  }

  getMangaShareUrl(mangaId: string): string {
    return this.mangaUrl(mangaId);
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private latestPageUrl(page: number): string {
    const dayMs = 24 * 60 * 60 * 1000;
    // Midnight UTC tomorrow.
    const now = new Date();
    const endMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const endMs = endMidnight - PAGE_DAYS * (page - 1) * dayMs;
    const startMs = endMs - PAGE_DAYS * dayMs;
    const endSec = Math.floor(endMs / 1000);
    const startSec = Math.floor(startMs / 1000);
    return `${BASE_URL}/folders?start=${startSec}&end=${endSec}`;
  }

  private parseDate(date: string): Date {
    if (!date) return new Date(0);
    // Upstream format: "MMMM dd'th', yyyy" (e.g. "January 1st, 2024").
    const cleaned = date.replace(/(\d+)(st|nd|rd|th)/i, "$1");
    const parsed = new Date(cleaned);
    return isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  private mangaUrl(mangaId: string): string {
    const slug = this.safeDecode(mangaId);
    if (slug.startsWith("http")) return slug;
    return `${BASE_URL}/${slug.replace(/^\/+/, "")}`;
  }

  private chapterUrl(chapterId: string): string {
    const slug = this.safeDecode(chapterId);
    if (slug.startsWith("http")) return slug;
    return `${BASE_URL}/${slug.replace(/^\/+/, "")}`;
  }

  private parsePath(href: string): string {
    const cleaned = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const slug = cleaned.startsWith("http")
      ? cleaned.replace(/^https?:\/\/[^/]+\//, "")
      : cleaned.replace(/^\/+/, "");
    return this.toSafeId(slug);
  }

  private toSafeId(slug: string): string {
    return slug.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
      const enc = encodeURIComponent(c);
      if (enc !== c) return enc;
      return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    });
  }

  private safeDecode(id: string): string {
    try {
      return decodeURIComponent(id);
    } catch {
      return id;
    }
  }

  private imageFromElement(img: Cheerio<AnyNode>): string {
    const src =
      img.attr("data-file") || img.attr("data-src") || img.attr("srcset") || img.attr("src") || "";
    return this.absoluteUrl(src.replace(/amp;/g, ""));
  }

  private absoluteUrl(src: string): string {
    const s = (src || "").trim().split(/\s+/)[0] || "";
    if (!s) return "";
    if (s.startsWith("http")) return s;
    if (s.startsWith("//")) return `https:${s}`;
    return s.startsWith("/") ? `${BASE_URL}${s}` : `${BASE_URL}/${s}`;
  }

  // ----------------------------------------------------------------
  // Cloudflare + fetch
  // ----------------------------------------------------------------

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies) {
      this.cookieStorageInterceptor.deleteCookie(cookie);
    }
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) continue;
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }

  async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    if (response.status === 404) {
      throw new Error("Content not found");
    }
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }
}

export const Doujins = new DoujinsExtension();
