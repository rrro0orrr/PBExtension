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
  PagedResults,
  Request,
  Response,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SourceManga,
  Tag,
} from "@paperback/types";
import {
  SearchFilterForm,
  type SearchFilter,
  type SearchFilterValue,
} from "@paperback/types/lib/compat/0.8/searchFilters";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { Interceptor, OS_DOMAIN } from "./interceptors";
import pbconfig from "./pbconfig";

type OSMetadata = { page?: number };

const SECTIONS: { id: string; title: string; path: string }[] = [
  { id: "new", title: "New Galleries", path: "" },
  { id: "top", title: "Top Galleries", path: "top" },
];

type OsosedkiImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class OsosedkiExtension implements OsosedkiImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new Interceptor("main");
  globalRateLimiter = new BasicRateLimiter("ratelimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
    this.requestManager.registerInterceptor();
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchCheerio({
      url: `${OS_DOMAIN}/photos/${mangaId}`,
      method: "GET",
    });

    const pages = this.parseImages($);

    // Photo alt text is "<gallery> - Photo <n>"; strip the photo number.
    const alt = $("figure.photo-item img").first().attr("alt")?.trim() ?? "";
    const titleString =
      alt.replace(/\s+-\s+Photo\s+\d+$/i, "").trim() ||
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      "";
    const title = decode(titleString);

    // Model / cosplay / fandom buttons above the photo grid
    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const el of $(".album-info a[href]").toArray()) {
      const id = pathFromUrl($(el).attr("href") ?? "");
      const tagTitle = decode($(el).text().trim());
      if (!id || !tagTitle || seen.has(id)) continue;
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

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
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

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const mangaId = chapter.sourceManga.mangaId;
    const $ = await this.fetchCheerio({
      url: `${OS_DOMAIN}/photos/${chapter.chapterId}`,
      method: "GET",
    });

    return { id: chapter.chapterId, mangaId, pages: this.parseImages($) };
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      type: DiscoverSectionType.simpleCarousel,
    }));
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: OSMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const def = SECTIONS.find((s) => s.id === section.id);
    if (!def) throw new Error(`Invalid section id: ${section.id}`);

    const page = metadata?.page ?? 1;
    const $ = await this.fetchCheerio({
      url: `${OS_DOMAIN}/${def.path}?page=${page}`,
      method: "GET",
    });

    const items: DiscoverSectionItem[] = this.parseGalleryList($).map((item) => ({
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

  async getSearchFilters(): Promise<SearchFilter[]> {
    const tags = await this.getTags().catch(() => [] as Tag[]);

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

  async getAdvancedSearchForm(query: SearchQuery<SearchFilterValue[]>): Promise<SearchFilterForm> {
    return new SearchFilterForm(query.metadata, this.getSearchFilters());
  }

  async getSearchResults(
    query: SearchQuery<SearchFilterValue[]>,
    metadata: OSMetadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const title = (query.title ?? "").trim().toLowerCase();
    const category = query.metadata?.find((f) => f.id === "category")?.value;

    let url: string;
    if (title) {
      url = `${OS_DOMAIN}/search?q=${encodeURIComponent(title)}&page=${page}`;
    } else if (typeof category === "string" && category) {
      // Older versions stored bare category slugs
      const path = category.includes("/") ? category : `category/${category}`;
      url = `${OS_DOMAIN}/${path}?page=${page}`;
    } else {
      url = `${OS_DOMAIN}/?page=${page}`;
    }

    const $ = await this.fetchCheerio({ url, method: "GET" });
    const items = this.parseGalleryList($);

    return {
      items,
      metadata: items.length ? { page: page + 1 } : undefined,
    };
  }

  async getTags(): Promise<Tag[]> {
    const $ = await this.fetchCheerio({ url: OS_DOMAIN, method: "GET" });

    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const el of $('a.dropdown-item[href*="/category/"]').toArray()) {
      const title = $(el).text().trim();
      const id = pathFromUrl($(el).attr("href") ?? "");
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      tags.push({ id, title: decode(title) });
    }
    return tags;
  }

  // ----- Cloudflare -----

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies) {
      this.cookieStorageInterceptor.deleteCookie(cookie);
    }
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) continue;
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }

  // ----- Helpers -----

  async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    await this.checkResponseError(request, response);
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }

  async checkResponseError(request: Request, response: Response): Promise<void> {
    switch (response.status) {
      case 403:
      case 503:
        throw new CloudflareError(
          { url: OS_DOMAIN, method: "GET" },
          "Cloudflare detected!\nPlease do the Cloudflare bypass to continue!",
        );
      case 404:
        throw new Error(`The requested page ${request.url} was not found!`);
      case 429:
        throw new Error(`Too many requests for ${request.url}!`);
    }
  }

  parseGalleryList($: CheerioAPI): SearchResultItem[] {
    const results: SearchResultItem[] = [];
    const seen = new Set<string>();

    // Ad tiles are div.gallery-item.banner-item; real galleries are <article>s.
    for (const item of $("#gallery article.gallery-item").toArray()) {
      const href = $("a.gallery-link", item).attr("href") ?? "";
      if (!href.includes("/photos/")) continue;
      const id = idFromUrl(href);
      if (!id || seen.has(id)) continue;

      const img = $("img.gallery-img", item).first();
      const title = $("h3", item).first().text().trim() || img.attr("alt")?.trim() || "";
      if (!title) continue;

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

  parseImages($: CheerioAPI): string[] {
    const pages: string[] = [];

    for (const el of $("#photos figure.photo-item").toArray()) {
      const img = $("img", el).first();
      const src = img.attr("data-src") ?? img.attr("src") ?? "";
      const image = absoluteUrl(
        src && !src.startsWith("data:") ? src : ($("a", el).first().attr("href") ?? ""),
      );
      if (!image || pages.includes(image)) continue;
      pages.push(image);
    }

    return pages;
  }
}

// ----- Utils -----

function absoluteUrl(url: string): string {
  url = url.trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return OS_DOMAIN + url;
  return url;
}

function decode(str: string): string {
  return Application.decodeHTMLEntities(str);
}

// "https://ososedki.com/model/Foo?x" -> "model/Foo"
function pathFromUrl(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\/[^/]+/, "")
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, "");
}

function idFromUrl(url: string): string {
  return url.trim().replace(/\/$/, "").split(/[?#]/)[0].split("/").pop() ?? "";
}

export const Ososedki = new OsosedkiExtension();
