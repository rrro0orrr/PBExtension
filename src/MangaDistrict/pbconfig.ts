import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
  name: "Manga District",
  description: "Extension that pulls content from mangadistrict.com",
  version: "1.0.2",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.MATURE,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    { label: "Madara", textColor: "#FFFFFF", backgroundColor: "#2E7D32" },
    { label: "Mature", textColor: "#FFFFFF", backgroundColor: "#C62828" },
  ],
  developers: [
    { name: "rrro0orrr", github: "https://github.com/rrro0orrr" },
    { name: "keiyoushi", github: "https://github.com/keiyoushi" },
  ],
} satisfies ExtensionInfo;
