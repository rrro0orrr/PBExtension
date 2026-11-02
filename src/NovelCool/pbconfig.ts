import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "NovelCool",
  description: "Extension that pulls English novels from novelcool.com.",
  version: "1.0.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.MATURE,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  badges: [],
  developers: [
    {
      name: "Karrot",
    },
  ],
} satisfies ExtensionInfo;
