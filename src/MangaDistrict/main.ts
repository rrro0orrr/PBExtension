import {
  Chapter,
  ContentRating,
  DiscoverSection,
  DiscoverSectionItem,
  Form,
  Metadata,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
} from "@paperback/types";
import { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";

import { MadaraExtension } from "../utils/madara/template";
import {
  chapterVersionPreference,
  cleanTitles,
  MangaDistrictSettingsForm,
  type ChapterVersionPreference,
} from "./settings";

// Bracketed version tags at the start or end of a title, e.g.
// "[MANGA DISTRICT EDITION] Man of Vengeance (UNCENSORED)" or
// "Moby Dick (Official)". Mirrors keiyoushi's MangaDistrict title cleaner.
const TAG = String.raw`(?:\([^()]*\)|\[[^\]]*\]|\{[^{}]*\}|«[^»]*»|「[^」]*」|『[^』]*』|《[^》]*》|〘[^〙]*〙|〖[^〗]*〗|⟨[^⟩]*⟩)`;
const LEADING_TAGS = new RegExp(String.raw`^(?:\s*${TAG}\s*)+`);
const TRAILING_TAGS = new RegExp(String.raw`(?:\s*(?:${TAG}|/\s*Official)\s*)+$`, "i");

/** Strip version tags from a title; keeps the original if nothing would remain. */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(LEADING_TAGS, "").replace(TRAILING_TAGS, "").trim();
  return cleaned || title.trim();
}

/**
 * Quality variant a chapter belongs to, read from its id. Variant copies live
 * under an extra path segment, e.g. `v2-full-quality/chapter-6_1` or
 * `v1-high-quality-optimized-for-moderate-data-usage/chapter-3`; the default
 * copy is just `chapter-6`.
 */
export function chapterVariant(chapterId: string): string | undefined {
  const id = decodeURIComponentSafe(chapterId);
  if (id.startsWith("/")) return undefined;
  const slash = id.lastIndexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

function variantLabel(variant: string): string {
  if (/^v2[-_]/i.test(variant)) return "V2 Full Quality";
  if (/^v1[-_]/i.test(variant)) return "V1 High Quality";
  return variant
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Lower is preferred. The default (no-variant) copy sits between V1 and V2. */
function variantRank(variant: string | undefined, preference: ChapterVersionPreference): number {
  const kind = !variant
    ? "plain"
    : /^v2[-_]/i.test(variant)
      ? "full"
      : /^v1[-_]/i.test(variant)
        ? "high"
        : "plain";
  const order = preference === "full" ? ["full", "plain", "high"] : ["high", "plain", "full"];
  return order.indexOf(kind);
}

/**
 * Label variant copies in their titles and, unless the user wants every
 * version, keep only the preferred copy of chapters listed more than once.
 */
export function applyChapterVersions(
  chapters: Chapter[],
  preference: ChapterVersionPreference,
): Chapter[] {
  const labelled = chapters.map((chapter) => {
    const variant = chapterVariant(chapter.chapterId);
    if (!variant) return chapter;
    const label = variantLabel(variant);
    const title = chapter.title ? `${chapter.title} · ${label}` : label;
    return { ...chapter, title };
  });
  if (preference === "all") return labelled;

  // Best rank among the copies of each chapter number.
  const best = new Map<number, number>();
  for (const chapter of labelled) {
    if (!(chapter.chapNum > 0)) continue;
    const rank = variantRank(chapterVariant(chapter.chapterId), preference);
    best.set(chapter.chapNum, Math.min(rank, best.get(chapter.chapNum) ?? Infinity));
  }
  return labelled.filter((chapter) => {
    if (!(chapter.chapNum > 0)) return true;
    return variantRank(chapterVariant(chapter.chapterId), preference) === best.get(chapter.chapNum);
  });
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Manga District (mangadistrict.com) runs a stock Madara theme with chapters
 * rendered inline on the series page. Overrides mirror keiyoushi's
 * MangaDistrict source: series live under `/series/`, pagination is
 * WP-PageNavi, chapter readers carry a decoy `#image-99999` banner plus
 * `<noscript>` copies of lazy images, and some covers use WP Fastest Cache's
 * `data-wpfc-original-src`.
 */
export class MangaDistrictExtension extends MadaraExtension {
  constructor() {
    super({
      name: "MangaDistrict",
      baseUrl: "https://mangadistrict.com",
      mangaSubString: "series",
      useNewChapterEndpoint: false,
      contentRating: ContentRating.MATURE,
      langCode: "🇬🇧",
      // `a.last` alone misses short result sets (search with two pages has no
      // "last" link), so also accept the link right after the current page.
      nextPageSelector: ".wp-pagenavi span.current + a, .wp-pagenavi a.last",
      pageListSelector: "div.page-break img:not(noscript img):not(#image-99999)",
    });
  }

  override async getSettingsForm(): Promise<Form> {
    return new MangaDistrictSettingsForm(this.sourceName, this.defaultBaseUrl);
  }

  override async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const result = await super.getDiscoverSectionItems(section, metadata);
    if (!cleanTitles()) return result;
    return {
      ...result,
      items: result.items.map((item) =>
        "title" in item && typeof item.title === "string"
          ? { ...item, title: cleanTitle(item.title) }
          : item,
      ),
    };
  }

  override async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const result = await super.getSearchResults(query, metadata, sortingOption);
    if (!cleanTitles()) return result;
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, title: cleanTitle(item.title) })),
    };
  }

  override async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const manga = await super.getMangaDetails(mangaId);
    if (!cleanTitles()) return manga;
    const original = manga.mangaInfo.primaryTitle;
    const cleaned = cleanTitle(original);
    if (cleaned === original) return manga;
    return {
      ...manga,
      mangaInfo: {
        ...manga.mangaInfo,
        primaryTitle: cleaned,
        // Keep the full title searchable as an alternative name.
        secondaryTitles: [original, ...manga.mangaInfo.secondaryTitles],
      },
    };
  }

  override async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return applyChapterVersions(await super.getChapters(sourceManga), chapterVersionPreference());
  }

  protected override imageFromElement(img: Cheerio<AnyNode>): string {
    const cached = img?.attr("data-wpfc-original-src")?.trim();
    if (cached) return this.absoluteUrl(cached);
    return super.imageFromElement(img);
  }
}

export const MangaDistrict = new MangaDistrictExtension();
