import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Novel Archive",
  description: "Extension that pulls web novels from novelarchive.cc.",
  version: "1.1.0",
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
