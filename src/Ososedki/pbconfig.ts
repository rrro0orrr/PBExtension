import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Ososedki",
  description: "Extension that pulls content from ososedki.com",
  version: "1.2.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  badges: [{ label: "18+", textColor: "#000000", backgroundColor: "#FFD700" }],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  developers: [
    {
      name: "Netsky",
      github: "https://github.com/TheNetsky",
    },
  ],
} satisfies ExtensionInfo;
