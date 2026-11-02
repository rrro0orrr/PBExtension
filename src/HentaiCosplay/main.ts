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
import { HC_DOMAIN, Interceptor } from "./interceptors";
import pbconfig from "./pbconfig";

type HCMetadata = { page?: number };

const SECTIONS: { id: string; title: string; path: string }[] = [
  { id: "new", title: "New Galleries", path: "search" },
  { id: "top_rated", title: "Most Popular Galleries", path: "ranking" },
  { id: "recently_viewed", title: "Recently Popular", path: "recently" },
];

type HentaiCosplayImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class HentaiCosplayExtension implements HentaiCosplayImplementation {
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
      url: `${HC_DOMAIN}/image/${mangaId}/`,
      method: "GET",
    });

    const title = decode(
      $("span#title > h2").first().text().trim() || $("#title").first().text().trim(),
    );
    const image =
      $("img", "div.icon-overlay").first().attr("src") ??
      $('meta[property="og:image"]').attr("content") ??
      "";

    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const el of $("a", "p#detail_tag").toArray()) {
      const id = idFromUrl($(el).attr("href") ?? "");
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
        thumbnailUrl: image,
        synopsis: `Gallery: ${title}`,
        status: "Completed",
        tagGroups: tags.length ? [{ id: "tags", title: "Tags", tags }] : [],
        contentRating: ContentRating.ADULT,
        shareUrl: `${HC_DOMAIN}/image/${mangaId}/`,
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
    // The "story" view lists every full-size image of the gallery
    const $ = await this.fetchCheerio({
      url: `${HC_DOMAIN}/story/${mangaId}/`,
      method: "GET",
    });

    const pages: string[] = [];
    for (const img of $("amp-story-grid-layer > amp-img").toArray()) {
      const image = $(img).attr("src");
      if (image && !pages.includes(image)) pages.push(image);
    }

    return { id: chapter.chapterId, mangaId, pages };
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
    metadata: HCMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const def = SECTIONS.find((s) => s.id === section.id);
    if (!def) throw new Error(`Invalid section id: ${section.id}`);

    const page = metadata?.page ?? 1;
    const $ = await this.fetchCheerio({
      url: pagedUrl(def.path, page),
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
      metadata: items.length && this.hasNextPage($, page) ? { page: page + 1 } : undefined,
    };
  }

  // ----- Search -----

  async getSearchFilters(): Promise<SearchFilter[]> {
    const tags = await this.getTags().catch(() => [] as Tag[]);

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

  async getAdvancedSearchForm(query: SearchQuery<SearchFilterValue[]>): Promise<SearchFilterForm> {
    return new SearchFilterForm(query.metadata, this.getSearchFilters());
  }

  async getSearchResults(
    query: SearchQuery<SearchFilterValue[]>,
    metadata: HCMetadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const title = (query.title ?? "").trim();
    const tagValue = query.metadata?.find((f) => f.id === "tag")?.value;
    const tag =
      typeof tagValue === "string" ? tagValue.trim().toLowerCase().replace(/\s+/g, "-") : "";

    let path: string;
    if (title) {
      path = `search/keyword/${encodeURIComponent(title)}`;
    } else if (tag) {
      path = `search/tag/${encodeURIComponent(tag)}`;
    } else {
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

  async getTags(): Promise<Tag[]> {
    const $ = await this.fetchCheerio({
      url: `${HC_DOMAIN}/ranking-tag/`,
      method: "GET",
    });

    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const el of $('a[href*="/search/tag/"]').toArray()) {
      const id = idFromUrl($(el).attr("href") ?? "");
      const title = decode($(el).text().trim()) || id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tags.push({ id, title });
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
          { url: HC_DOMAIN, method: "GET" },
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

    for (const item of $("div.image-list-item", "ul#image-list").toArray()) {
      const href = $("a", item).first().attr("href") ?? "";
      // Skip video posts and links to partner sites
      const match = href.match(/\/image\/([^/?#]+)/);
      const id = match?.[1];
      if (!id || seen.has(id)) continue;
      if (/^https?:\/\//.test(href) && !href.startsWith(HC_DOMAIN)) continue;

      const title = $("p.image-list-item-title > a", item).text().trim();
      if (!title) continue;

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

  hasNextPage($: CheerioAPI, page: number): boolean {
    if ($("div.wp-pagenavi a.last, div.wp-pagenavi a.nextpostslink").length > 0) {
      return true;
    }
    return $(`a[href*="/page/${page + 1}/"], a[href$="/page/${page + 1}"]`).length > 0;
  }
}

// ----- Utils -----

function pagedUrl(path: string, page: number): string {
  return page === 1 ? `${HC_DOMAIN}/${path}/` : `${HC_DOMAIN}/${path}/page/${page}/`;
}

function decode(str: string): string {
  return Application.decodeHTMLEntities(str);
}

function idFromUrl(url: string): string {
  return url.trim().replace(/\/$/, "").split("/").pop() ?? "";
}

export const HentaiCosplay = new HentaiCosplayExtension();
