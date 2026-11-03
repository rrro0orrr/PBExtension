import { ContentRating } from "@paperback/types";
import { MadaraExtension } from "../utils/madara/template";

export const MadaraDex = new MadaraExtension({
  name: "MadaraDex",
  baseUrl: "https://madaradex.org",
  mangaSubString: "title",
  useNewChapterEndpoint: false,
  mdxAuth: true,
  contentRating: ContentRating.MATURE,
  langCode: "🇬🇧",
});
