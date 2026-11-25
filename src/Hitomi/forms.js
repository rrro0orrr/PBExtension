/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { ButtonRow, EditSection, Form, FormConfirmationError, InputRow, LabelRow, NavigationRow, Section, SelectRow, StepperRow, ToggleRow, } from "@paperback/types";
import { ALL_DISCOVER_SECTIONS, DATE_SEPARATOR_OPTIONS, DEFAULT_SECTION_ORDER, getDateFormatOptionsWithSeparator, getDateFormatSetting, getDateSeparatorSetting, getDiscoverCarouselTilesSetting, getDiscoverPageTilesSetting, getDiscoverSectionOrder, getDisplayOptionsSetting, getEnableRelatedSetting, getExcludeTagsSetting, getFuzzySearchTagsSetting, getHiddenSections, getHideReadInRelatedSetting, getHideReadSetting, getIncludeTagsSetting, getIncognitoModeSetting, getLanguageSetting, getMarkReadOnViewSetting, getOnlyFuzzyUnknownTagsSetting, getPagesExpressionSetting, getPreferredImageFormatSetting, getRemoveSeparatorSpacesSetting, getScreenTimeEnabledSetting, getSearchPageTilesSetting, getThumbnailQualitySetting, LANGUAGE_OPTIONS, PREFERRED_IMAGE_FORMAT_OPTIONS, resetHitomiSettings, sanitizePagesExpressionInput, setDateFormatSetting, setDateSeparatorSetting, setDiscoverCarouselTilesSetting, setDiscoverPageTilesSetting, setDiscoverSectionOrder, setDisplayOptionsSetting, setEnableRelatedSetting, setExcludeTagsSetting, setFuzzySearchTagsSetting, setHiddenSections, setHideReadInRelatedSetting, setHideReadSetting, setIncludeTagsSetting, setIncognitoModeSetting, setLanguageSetting, setMarkReadOnViewSetting, setOnlyFuzzyUnknownTagsSetting, setPagesExpressionSetting, setPreferredImageFormatSetting, setRemoveSeparatorSpacesSetting, setSearchPageTilesSetting, setThumbnailQualitySetting, } from "./settings";
import { StatisticsForm } from "./statistics";
function getDateExampleFor(dateFormatId, separator) {
    const now = new Date();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const m = (now.getMonth() + 1).toString();
    const dd = now.getDate().toString().padStart(2, "0");
    const d = now.getDate().toString();
    const yyyy = now.getFullYear().toString();
    const yy = yyyy.slice(-2);
    const patterns = {
        mm_dd_yy: `${mm}${separator}${dd}${separator}${yy}`,
        dd_mm_yyyy: `${dd}${separator}${mm}${separator}${yyyy}`,
        yyyy_mm_dd: `${yyyy}${separator}${mm}${separator}${dd}`,
        m_d_yy: `${m}${separator}${d}${separator}${yy}`,
        mm_yy: `${mm}${separator}${yy}`,
        yy_mm: `${yy}${separator}${mm}`,
        m_yy: `${m}${separator}${yy}`,
        yy_m: `${yy}${separator}${m}`,
    };
    return patterns[dateFormatId] || "";
}
// Get dynamic separator options using current date format
export function getDateSeparatorOptionsWithFormat(format) {
    const names = {
        period: "Period",
        dash: "Dash",
        slash: "Slash",
        comma: "Comma",
        space: "Space",
    };
    return DATE_SEPARATOR_OPTIONS.map((opt) => {
        return {
            id: opt.id,
            label: `${getDateExampleFor(format, opt.char)} - ${names[opt.id]}`,
        };
    });
}
const DISPLAY_OPTION_IDS = [
    "hide_read_letter",
    "show_lang_tip",
    "show_page_count",
    "subtitle_date",
    "subtitle_relative",
    "desc_show_date",
    "desc_relative_date",
    "parodies_bottom",
    "show_tags_in_desc",
    "show_tag_counts",
    "show_tags_alpha",
    "abbreviate_tag_counts",
    "show_manga_id_in_description",
    "show_related_order",
    "show_reread_count",
];
function getSelectedOptionTitle(options, selectedId) {
    const option = options.find((entry) => entry.id === selectedId);
    return option?.label ?? option?.title ?? selectedId;
}
function _getLanguageSummary(values) {
    if (values.includes("all"))
        return "All Languages";
    return values.map((id) => getSelectedOptionTitle(LANGUAGE_OPTIONS, id)).join(", ");
}
function _getDateFormatDisplayValue(dateFormat, dateSeparator) {
    const sep = DATE_SEPARATOR_OPTIONS.find((s) => s.id === dateSeparator)?.char ?? ".";
    return getDateExampleFor(dateFormat, sep);
}
function _getDateSeparatorDisplayValue(dateSeparator) {
    const option = DATE_SEPARATOR_OPTIONS.find((entry) => entry.id === dateSeparator);
    return option ? `${option.id} (${option.char})` : dateSeparator;
}
class _HitomiLanguageSettingsForm extends Form {
    languageSetting = getLanguageSetting();
    async updateLanguage(value) {
        const selected = Array.isArray(value) && value.length > 0 ? value : this.languageSetting;
        this.languageSetting = selected;
        setLanguageSetting(this.languageSetting);
        this.reloadForm();
    }
    getSections() {
        return [
            Section("language", [
                SelectRow("language", {
                    title: "Preferred Language",
                    layout: "list",
                    value: this.languageSetting,
                    options: LANGUAGE_OPTIONS.map((option) => ({
                        id: option.id,
                        title: option.label,
                    })),
                    minItemCount: 1,
                    maxItemCount: LANGUAGE_OPTIONS.length,
                    onValueChange: Application.Selector(this, "updateLanguage"), // eslint-disable-line @typescript-eslint/no-explicit-any
                }),
            ]),
        ];
    }
}
class _HitomiImageFormatSettingsForm extends Form {
    preferredImageFormat = getPreferredImageFormatSetting();
    async updatePreferredImageFormat(value) {
        const selected = value?.[0] ?? this.preferredImageFormat;
        this.preferredImageFormat = selected;
        setPreferredImageFormatSetting(selected);
        this.reloadForm();
    }
    getSections() {
        return [
            Section("imageFormat", [
                SelectRow("preferredImageFormat", {
                    title: "Image Format",
                    layout: "list",
                    value: [this.preferredImageFormat],
                    options: PREFERRED_IMAGE_FORMAT_OPTIONS.map((option) => ({
                        id: option.id,
                        title: option.label,
                    })),
                    minItemCount: 1,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updatePreferredImageFormat"),
                }),
            ]),
        ];
    }
}
// Display option labels with examples
function getDisplayOptionLabel(id, dateFormat, dateSeparator, removeSpaces) {
    const sep = DATE_SEPARATOR_OPTIONS.find((s) => s.id === dateSeparator)?.char ?? ".";
    const dateExample = getDateExampleFor(dateFormat, sep);
    const relativeExample = "9d"; // Example: 9 days ago
    // Format separators based on removeSpaces setting - trailing pipe only
    const langEx = removeSpaces ? '("EN|")' : '("EN | ")';
    const pageEx = removeSpaces ? '("67p|")' : '("67p | ")';
    const dateEx = removeSpaces ? `("${dateExample}|")` : `("${dateExample} | ")`;
    const relEx = removeSpaces ? `("${relativeExample}|")` : `("${relativeExample} | ")`;
    const labels = {
        hide_read: "Hide Read Manga",
        hide_read_letter: "Show Read Indicator 'r'",
        show_lang_tip: `Show Language in Subtitle ${langEx}`,
        show_page_count: `Show Page Count ${pageEx}`,
        subtitle_date: `Show Date in Subtitle ${dateEx}`,
        subtitle_relative: `Show Relative Date in Subtitle ${relEx}`,
        desc_show_date: `Show Date in Description ${dateEx}`,
        desc_relative_date: `Show Relative Date in Description ${relEx}`,
        parodies_bottom: "Show Characters in Description",
        show_tags_in_desc: "Show Tags in Description",
        show_related_order: "Show Related Count and Order",
        show_manga_id_in_description: "Show Manga ID in Description",
        show_tag_counts: "Show Tag Counts in Search Filters",
        abbreviate_tag_counts: 'Show Tag Count Abbreviations ("11k")',
        show_reread_count: "Show Reread Count",
        show_tags_alpha: "Show Tags Alphabetically in Search",
    };
    return labels[id] || id;
}
export class HitomiSettingsForm extends Form {
    languageSetting = getLanguageSetting();
    dateFormat = getDateFormatSetting();
    dateSeparator = getDateSeparatorSetting();
    displayOptions = getDisplayOptionsSetting();
    thumbnailQuality = getThumbnailQualitySetting();
    preferredImageFormat = getPreferredImageFormatSetting();
    removeSpaces = getRemoveSeparatorSpacesSetting();
    _mangaFiltersForm;
    _statisticsForm;
    getMangaFiltersForm() {
        if (!this._mangaFiltersForm)
            this._mangaFiltersForm = new MangaFiltersForm();
        return this._mangaFiltersForm;
    }
    getStatisticsForm() {
        if (!this._statisticsForm)
            this._statisticsForm = new StatisticsForm();
        return this._statisticsForm;
    }
    getSections() {
        // Build display options with dynamic date examples
        // Build subtitle example based on current display options
        const sep = this.removeSpaces ? "|" : " | ";
        const parts = [];
        if (this.displayOptions.includes("show_lang_tip"))
            parts.push("EN");
        if (this.displayOptions.includes("show_page_count"))
            parts.push("67p");
        if (this.displayOptions.includes("subtitle_relative"))
            parts.push("5h");
        if (this.displayOptions.includes("subtitle_date")) {
            const dateSep = DATE_SEPARATOR_OPTIONS.find((s) => s.id === this.dateSeparator)?.char ?? ".";
            parts.push(getDateExampleFor(this.dateFormat, dateSep));
        }
        const subtitleExample = parts.length > 0 ? parts.join(sep) : this.removeSpaces ? "EN|67p" : "EN | 67p";
        return [
            // Main settings section
            Section("hitomiMain", [
                LabelRow("topLabel", {
                    title: "Hitomi Settings",
                    subtitle: `Subtitle Preview: ${subtitleExample}`,
                }),
                SelectRow("languageNav", {
                    title: this.languageSetting.length === 1 && this.languageSetting[0] !== "all"
                        ? "Preferred Language"
                        : "Preferred Languages",
                    layout: "list",
                    value: this.languageSetting,
                    items: LANGUAGE_OPTIONS.map((option) => ({
                        id: option.id,
                        title: option.label,
                    })),
                    onValueChange: Application.Selector(this, "updateLanguage"),
                    minItemCount: 1,
                    maxItemCount: LANGUAGE_OPTIONS.length,
                }),
            ]),
            // Thumbnail and Display Options section
            Section("displaySettingsNav", [
                // Display Options first
                SelectRow("displayOptionsNav", {
                    title: "Display Options",
                    layout: "list",
                    value: this.displayOptions,
                    options: DISPLAY_OPTION_IDS.map((id) => ({
                        id,
                        title: getDisplayOptionLabel(id, this.dateFormat, this.dateSeparator, this.removeSpaces),
                    })),
                    onValueChange: Application.Selector(this, "updateDisplayOptions"),
                    minItemCount: 0,
                    maxItemCount: DISPLAY_OPTION_IDS.length,
                }),
                SelectRow("preferredImageFormatNav", {
                    title: "Image Format",
                    layout: "list",
                    value: [this.preferredImageFormat],
                    options: PREFERRED_IMAGE_FORMAT_OPTIONS.map((opt) => ({
                        id: opt.id,
                        title: opt.label,
                    })),
                    onValueChange: Application.Selector(this, "updatePreferredImageFormat"),
                    minItemCount: 1,
                    maxItemCount: 1,
                }),
                ToggleRow("highQualityThumbnails", {
                    title: "High Quality Thumbnails",
                    value: this.thumbnailQuality === "high",
                    onValueChange: Application.Selector(this, "updateHighQualityThumbnails"),
                }),
                ToggleRow("removeSpaces", {
                    title: "Remove Spaces From Separators",
                    value: this.removeSpaces,
                    onValueChange: Application.Selector(this, "updateRemoveSpaces"),
                }),
            ]),
            // Statistics section
            Section("statistics", [
                NavigationRow("mangaFiltersNav", {
                    title: "Manga Filters",
                    subtitle: "Applies To Search And Discover",
                    form: this.getMangaFiltersForm(),
                }),
                NavigationRow("discoverOrderNav", {
                    title: "Home & Search Sections",
                    subtitle: "Toggle & Reorder Sections",
                    form: new DiscoverOrderForm(),
                }),
                NavigationRow("statisticsNav", {
                    title: getScreenTimeEnabledSetting() ? "Statistics & Screen Time" : "Statistics",
                    form: this.getStatisticsForm(),
                }),
            ]),
            // Date and Format Settings section
            Section({
                id: "dateSettings",
                footer: 'Known App Limitation:\n\nCrashes occur due to memory issues. Enabling "Downsample Pages" in the reader may help.',
            }, [
                SelectRow("dateFormatNav", {
                    title: "Date Format",
                    layout: "list",
                    value: [this.dateFormat],
                    options: getDateFormatOptionsWithSeparator(this.dateSeparator).map((opt) => ({
                        id: opt.id,
                        title: opt.label,
                    })),
                    onValueChange: Application.Selector(this, "updateDateFormat"),
                    minItemCount: 1,
                    maxItemCount: 1,
                }),
                SelectRow("dateSeparatorNav", {
                    title: "Date Separator",
                    layout: "list",
                    value: [this.dateSeparator],
                    options: getDateSeparatorOptionsWithFormat(this.dateFormat).map((opt) => ({
                        id: opt.id,
                        title: opt.label,
                    })),
                    onValueChange: Application.Selector(this, "updateDateSeparator"),
                    minItemCount: 1,
                    maxItemCount: 1,
                }),
            ]),
            // Reset section
            Section("reset", [
                ButtonRow("resetSettings", {
                    title: "Reset Settings",
                    onSelect: Application.Selector(this, "confirmReset"),
                }),
            ]),
        ];
    }
    async updateLanguage(value) {
        const selected = Array.isArray(value) && value.length > 0 ? value : this.languageSetting;
        this.languageSetting = selected;
        setLanguageSetting(this.languageSetting);
    }
    async updateHighQualityThumbnails(value) {
        this.thumbnailQuality = value ? "high" : "low";
        setThumbnailQualitySetting(this.thumbnailQuality);
    }
    async updatePreferredImageFormat(value) {
        const selected = value?.[0] ?? this.preferredImageFormat;
        this.preferredImageFormat = selected;
        setPreferredImageFormatSetting(selected);
        this.reloadForm();
    }
    async updateRemoveSpaces(value) {
        this.removeSpaces = !!value;
        setRemoveSeparatorSpacesSetting(this.removeSpaces);
        this.reloadForm();
    }
    async updateDateFormat(value) {
        const rawSelected = value?.[0];
        const selected = rawSelected !== undefined ? rawSelected : this.dateFormat;
        this.dateFormat = selected;
        setDateFormatSetting(selected);
        this.reloadForm();
    }
    async updateDateSeparator(value) {
        const selected = value?.[0] ?? this.dateSeparator;
        this.dateSeparator = selected;
        setDateSeparatorSetting(selected);
        this.reloadForm();
    }
    async updateDisplayOptions(value) {
        this.displayOptions = value;
        setDisplayOptionsSetting(this.displayOptions);
        this.reloadForm();
    }
    async confirmReset() {
        throw new FormConfirmationError(Application.Selector(this, "handleReset"), "Reset Hitomi settings to their defaults?");
    }
    async handleReset() {
        resetHitomiSettings();
        this.languageSetting = getLanguageSetting();
        this.dateFormat = getDateFormatSetting();
        this.dateSeparator = getDateSeparatorSetting();
        this.displayOptions = getDisplayOptionsSetting();
        this.thumbnailQuality = getThumbnailQualitySetting();
        this.preferredImageFormat = getPreferredImageFormatSetting();
        this.removeSpaces = getRemoveSeparatorSpacesSetting();
        this.reloadForm();
    }
}
// -- Discover Order Form --
class DiscoverOrderForm extends Form {
    order = getDiscoverSectionOrder();
    hidden = getHiddenSections();
    constructor() {
        super();
    }
    getVisibleIds() {
        return this.order.filter((id) => !this.hidden.has(id));
    }
    getHiddenIds() {
        return this.order.filter((id) => this.hidden.has(id));
    }
    persistLists(visibleIds, hiddenIds) {
        const knownIds = ALL_DISCOVER_SECTIONS.map((section) => section.id);
        const seen = new Set();
        const nextVisible = visibleIds.filter((id) => {
            if (!knownIds.includes(id) || seen.has(id))
                return false;
            seen.add(id);
            return true;
        });
        const nextHidden = hiddenIds.filter((id) => {
            if (!knownIds.includes(id) || seen.has(id))
                return false;
            seen.add(id);
            return true;
        });
        for (const id of knownIds) {
            if (!seen.has(id)) {
                nextVisible.push(id);
                seen.add(id);
            }
        }
        this.order = [...nextVisible, ...nextHidden];
        this.hidden = new Set(nextHidden);
        setDiscoverSectionOrder(this.order);
        setHiddenSections(this.hidden);
    }
    reorderListByIndices(list, srcIndex, destIndex) {
        const length = list.length;
        if (length < 2)
            return list;
        const normalizedSrc = Math.trunc(Number(srcIndex));
        const normalizedDestInput = Math.trunc(Number(destIndex));
        if (!Number.isFinite(normalizedSrc) || !Number.isFinite(normalizedDestInput)) {
            return list;
        }
        if (normalizedSrc < 0 || normalizedSrc >= length)
            return list;
        const normalizedDest = Math.max(0, Math.min(normalizedDestInput, length));
        if (normalizedDest === normalizedSrc) {
            return list;
        }
        const next = [...list];
        const [moved] = next.splice(normalizedSrc, 1);
        if (!moved)
            return list;
        const boundedDest = Math.max(0, Math.min(normalizedDest, next.length));
        next.splice(boundedDest, 0, moved);
        return next;
    }
    async rowDidReorderVisible(srcIndex, destIndex) {
        const visible = this.getVisibleIds();
        const hidden = this.getHiddenIds();
        const nextVisible = this.reorderListByIndices(visible, srcIndex, destIndex);
        if (nextVisible.length === visible.length &&
            nextVisible.every((id, index) => id === visible[index])) {
            return;
        }
        this.persistLists(nextVisible, hidden);
        this.reloadForm();
    }
    async rowDidReorderHidden(srcIndex, destIndex) {
        const visible = this.getVisibleIds();
        const hidden = this.getHiddenIds();
        const nextHidden = this.reorderListByIndices(hidden, srcIndex, destIndex);
        if (nextHidden.length === hidden.length &&
            nextHidden.every((id, index) => id === hidden[index])) {
            return;
        }
        this.persistLists(visible, nextHidden);
        this.reloadForm();
    }
    async rowDidDeleteVisible(index) {
        const visible = this.getVisibleIds();
        const hidden = this.getHiddenIds();
        const normalizedIndex = Math.trunc(Number(index));
        if (!Number.isFinite(normalizedIndex))
            return;
        if (normalizedIndex < 0 || normalizedIndex >= visible.length)
            return;
        const [id] = visible.splice(normalizedIndex, 1);
        if (!id)
            return;
        if (!hidden.includes(id))
            hidden.push(id);
        this.persistLists(visible, hidden);
        this.reloadForm();
    }
    async rowDidDeleteHidden(index) {
        const visible = this.getVisibleIds();
        const hidden = this.getHiddenIds();
        const normalizedIndex = Math.trunc(Number(index));
        if (!Number.isFinite(normalizedIndex))
            return;
        if (normalizedIndex < 0 || normalizedIndex >= hidden.length)
            return;
        const [id] = hidden.splice(normalizedIndex, 1);
        if (!id)
            return;
        if (!visible.includes(id))
            visible.push(id);
        this.persistLists(visible, hidden);
        this.reloadForm();
    }
    getSections() {
        const sectionMap = new Map(ALL_DISCOVER_SECTIONS.map((s) => [s.id, s]));
        const visibleIds = this.getVisibleIds();
        const hiddenIds = this.getHiddenIds();
        const visibleRows = visibleIds
            .map((id) => {
            const def = sectionMap.get(id);
            if (!def)
                return undefined;
            return LabelRow(`visible_${id}`, {
                title: def.title,
                subtitle: def.subtitle,
            });
        })
            .filter((row) => row !== undefined);
        const hiddenRows = hiddenIds
            .map((id) => {
            const def = sectionMap.get(id);
            if (!def)
                return undefined;
            return LabelRow(`hidden_${id}`, {
                title: def.title,
                subtitle: def.subtitle,
            });
        })
            .filter((row) => row !== undefined);
        return [
            EditSection("visibleOrdering", {
                id: "visibleOrdering",
                header: "VISIBLE ORDERING",
                footer: "Drag to reorder. Swipe to hide.",
                items: visibleRows,
                allowReorder: true,
                allowDeletion: true,
                onReorder: Application.Selector(this, "rowDidReorderVisible"),
                onDeletion: Application.Selector(this, "rowDidDeleteVisible"),
            }),
            EditSection("hiddenSections", {
                id: "hiddenSections",
                header: "HIDDEN SECTIONS",
                items: hiddenRows,
                allowReorder: true,
                allowDeletion: true,
                onReorder: Application.Selector(this, "rowDidReorderHidden"),
                onDeletion: Application.Selector(this, "rowDidDeleteHidden"),
            }),
            Section("resetOrder", [
                ButtonRow("resetOrderBtn", {
                    title: "Reset to Default Order",
                    onSelect: Application.Selector(this, "confirmReset"),
                }),
            ]),
        ];
    }
    async confirmReset() {
        throw new FormConfirmationError(Application.Selector(this, "handleReset"), "Reset the Hitomi section order and visibility settings?");
    }
    async handleReset() {
        this.order = [...DEFAULT_SECTION_ORDER];
        this.hidden = new Set();
        setDiscoverSectionOrder(this.order);
        setHiddenSections(this.hidden);
        this.reloadForm();
    }
}
function stripTagPrefix(value) {
    return value
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
        // Check if this is an OR group (contains || or OR)
        if (/\s*\|\|\s*|\s+OR\s+/i.test(t)) {
            // Split by OR but preserve the OR syntax
            const orParts = t
                .split(/\s*\|\|\s*|\s+OR\s+/i)
                .map((part) => {
                let clean = part.trim();
                if (clean.startsWith("-"))
                    clean = clean.slice(1);
                const prefixMatch = clean.match(/^(?:tag|female|male|artist|group|series|character|language):(.+)$/i);
                if (prefixMatch) {
                    clean = prefixMatch[1];
                }
                if (clean.startsWith('"') && clean.endsWith('"')) {
                    clean = clean.slice(1, -1);
                }
                return clean;
            })
                .filter(Boolean);
            return orParts.join(" OR ");
        }
        else {
            let clean = t.startsWith("-") ? t.slice(1) : t;
            const prefixMatch = clean.match(/^(?:tag|female|male|artist|group|series|character|language):(.+)$/i);
            if (prefixMatch) {
                clean = prefixMatch[1];
            }
            if (clean.startsWith('"') && clean.endsWith('"')) {
                clean = clean.slice(1, -1);
            }
            return clean;
        }
    })
        .join(", ");
}
class MangaFiltersForm extends Form {
    includeTags = getIncludeTagsSetting();
    excludeTags = getExcludeTagsSetting();
    pagesExpr = getPagesExpressionSetting();
    discoverCarouselTiles = getDiscoverCarouselTilesSetting();
    discoverPageTiles = getDiscoverPageTilesSetting();
    searchPageTiles = getSearchPageTilesSetting();
    incognito = getIncognitoModeSetting();
    hideRead = getHideReadSetting();
    enableRelated = getEnableRelatedSetting();
    hideReadInRelated = getHideReadInRelatedSetting();
    markReadOnView = getMarkReadOnViewSetting();
    fuzzySearchTags = getFuzzySearchTagsSetting();
    onlyFuzzyUnknown = getOnlyFuzzyUnknownTagsSetting();
    normalizeStepperValue(value, min, max, fallback) {
        const normalized = Array.isArray(value) && value.length > 0 ? value[0] : value;
        let parsed = NaN;
        if (typeof normalized === "number") {
            parsed = normalized;
        }
        else if (typeof normalized === "string") {
            parsed = Number.parseInt(normalized, 10);
        }
        else if (typeof normalized === "boolean") {
            parsed = normalized ? 1 : 0;
        }
        if (!Number.isFinite(parsed))
            return fallback;
        return Math.max(min, Math.min(max, Math.floor(parsed)));
    }
    getSections() {
        return [
            Section("tileLayoutSection", [
                StepperRow("discoverCarouselTiles", {
                    title: "Tiles on Carousel",
                    value: this.discoverCarouselTiles,
                    minValue: 1,
                    maxValue: 16,
                    stepValue: 1,
                    loopOver: false,
                    onValueChange: Application.Selector(this, "updateDiscoverCarouselTiles"),
                }),
                StepperRow("discoverPageTiles", {
                    title: "Tiles on Discover",
                    value: this.discoverPageTiles,
                    minValue: 1,
                    maxValue: 48,
                    stepValue: 1,
                    loopOver: false,
                    onValueChange: Application.Selector(this, "updateDiscoverPageTiles"),
                }),
                StepperRow("searchPageTiles", {
                    title: "Tiles on Search",
                    value: this.searchPageTiles,
                    minValue: 1,
                    maxValue: 48,
                    stepValue: 1,
                    loopOver: false,
                    onValueChange: Application.Selector(this, "updateSearchPageTiles"),
                }),
            ]),
            // Section 1: Tags, filters, and fuzzy toggle
            Section("filtersSection", [
                ToggleRow("fuzzySearchTags", {
                    title: "Always Force Fuzzy Search",
                    subtitle: this.fuzzySearchTags
                        ? "Use 'uf!' for exact tag searches (e.g., 'uf!sole female, ana')."
                        : "Use 'f!' for fuzzy searches (e.g., 'f!ana' matches 'anal birth', 'mana', 'anal').",
                    value: this.fuzzySearchTags,
                    onValueChange: Application.Selector(this, "updateFuzzySearchTags"),
                }),
                ...(!this.fuzzySearchTags
                    ? [
                        ToggleRow("onlyFuzzyUnknown", {
                            title: "Fuzzy Search Unknown Tags",
                            subtitle: "Always Fuzzy Nonexistent Tags",
                            value: this.onlyFuzzyUnknown,
                            onValueChange: Application.Selector(this, "updateOnlyFuzzyUnknown"),
                        }),
                    ]
                    : []),
                InputRow("includeTags", {
                    title: this.fuzzySearchTags
                        ? "Included Tags (e.g. elf OR uf!oil)"
                        : "Included Tags (e.g. elf, nun OR orc)",
                    value: stripTagPrefix(this.includeTags),
                    onValueChange: Application.Selector(this, "updateIncludeTags"),
                }),
                InputRow("excludeTags", {
                    title: this.fuzzySearchTags
                        ? "Excluded Tags (e.g. scat, uf!anal)"
                        : "Excluded Tags (e.g. scat, f!oil)",
                    value: stripTagPrefix(this.excludeTags),
                    onValueChange: Application.Selector(this, "updateExcludeTags"),
                }),
                InputRow("pagesFilter", {
                    title: "Page Count (e.g. 20-50, >21, <67, 69<)",
                    value: this.pagesExpr,
                    onValueChange: Application.Selector(this, "updatePagesExpr"),
                }),
            ]),
            // Section 2: Behavior toggles — single section, reordered
            Section("behaviorSection", [
                ToggleRow("pauseHideRead", {
                    title: "Pause Read Manga Tracking",
                    subtitle: "Paperback Continues Tracking History",
                    value: this.incognito,
                    onValueChange: Application.Selector(this, "updateIncognito"),
                }),
                ToggleRow("hideReadInRelated", {
                    title: "Hide Read Manga in Related",
                    subtitle: "Applies To Related Manga Section",
                    value: this.hideReadInRelated,
                    onValueChange: Application.Selector(this, "updateHideReadInRelated"),
                }),
                ToggleRow("hideRead", {
                    title: "Hide Read Manga",
                    subtitle: "Applies to Search and Discover",
                    value: this.hideRead,
                    onValueChange: Application.Selector(this, "updateHideRead"),
                }),
                ToggleRow("markReadOnView", {
                    title: "Mark As Read On Description",
                    subtitle: "Mark Manga as Read When Viewing Their Description",
                    value: this.markReadOnView,
                    onValueChange: Application.Selector(this, "updateMarkReadOnView"),
                }),
            ]),
        ];
    }
    async updateIncludeTags(value) {
        // Store the raw value - backend will handle tag validation
        setIncludeTagsSetting(value ?? "");
        this.includeTags = getIncludeTagsSetting();
        this.reloadForm();
        try {
            globalThis.__hitomiClearSearchCaches?.();
        }
        catch {
            /* ignore */
        }
    }
    async updateExcludeTags(value) {
        // Store the raw value - backend will handle tag validation
        setExcludeTagsSetting(value ?? "");
        this.excludeTags = getExcludeTagsSetting();
        this.reloadForm();
        try {
            globalThis.__hitomiClearSearchCaches?.();
        }
        catch {
            /* ignore */
        }
    }
    async updatePagesExpr(value) {
        this.pagesExpr = sanitizePagesExpressionInput(value ?? "");
        setPagesExpressionSetting(this.pagesExpr);
        this.pagesExpr = getPagesExpressionSetting();
        this.reloadForm();
    }
    async updateDiscoverCarouselTiles(value) {
        this.discoverCarouselTiles = this.normalizeStepperValue(value, 1, 16, this.discoverCarouselTiles);
        setDiscoverCarouselTilesSetting(this.discoverCarouselTiles);
        this.reloadForm();
    }
    async updateDiscoverPageTiles(value) {
        this.discoverPageTiles = this.normalizeStepperValue(value, 1, 48, this.discoverPageTiles);
        setDiscoverPageTilesSetting(this.discoverPageTiles);
        this.reloadForm();
    }
    async updateSearchPageTiles(value) {
        this.searchPageTiles = this.normalizeStepperValue(value, 1, 48, this.searchPageTiles);
        setSearchPageTilesSetting(this.searchPageTiles);
        this.reloadForm();
    }
    async updateIncognito(value) {
        this.incognito = !!value;
        setIncognitoModeSetting(this.incognito);
        if (this.incognito && this.markReadOnView) {
            this.markReadOnView = false;
            setMarkReadOnViewSetting(false);
        }
        this.reloadForm();
    }
    async updateHideRead(value) {
        this.hideRead = !!value;
        setHideReadSetting(this.hideRead);
        this.reloadForm();
    }
    async updateEnableRelated(value) {
        this.enableRelated = !!value;
        setEnableRelatedSetting(this.enableRelated);
        if (!this.enableRelated && this.hideReadInRelated) {
            this.hideReadInRelated = false;
            setHideReadInRelatedSetting(false);
        }
        this.reloadForm();
    }
    async updateHideReadInRelated(value) {
        this.hideReadInRelated = !!value;
        setHideReadInRelatedSetting(this.hideReadInRelated);
    }
    async updateMarkReadOnView(value) {
        this.markReadOnView = !!value;
        setMarkReadOnViewSetting(this.markReadOnView);
    }
    async updateFuzzySearchTags(value) {
        this.fuzzySearchTags = !!value;
        setFuzzySearchTagsSetting(this.fuzzySearchTags);
        this.reloadForm();
    }
    async updateOnlyFuzzyUnknown(value) {
        this.onlyFuzzyUnknown = !!value;
        setOnlyFuzzyUnknownTagsSetting(this.onlyFuzzyUnknown);
        this.reloadForm();
    }
}
