import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Doujins",
  description: "Extension that pulls content from doujins.com",
  version: "1.0.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  badges: [{ label: "18+", textColor: "#000000", backgroundColor: "#FFD700" }],
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  developers: [
    { name: "nicartjay", github: "https://github.com/Nicartjay" },
    { name: "keiyoushi", github: "https://github.com/keiyoushi" },
  ],
} satisfies ExtensionInfo;
