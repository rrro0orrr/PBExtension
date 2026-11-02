import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Mgeko",
  description: "Extension that pulls manga, manhwa and manhua from mgeko.cc.",
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
  badges: [{ label: "Aggregator", textColor: "#FFFFFF", backgroundColor: "#800080" }],
  developers: [
    {
      name: "Karrot",
    },
  ],
} satisfies ExtensionInfo;
