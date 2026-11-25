/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
export const DOMAIN = "https://www.novelcool.com";
export const API_URL = "https://api.novelcool.com";
export const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
export const PAGE_SIZE = 20;
export const API_HEADERS = {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "Android/Package:com.zuoyou.novel - Version Name:2.3 - Phone Info:sdk_gphone_x86_64(Android Version:13)",
};
export const API_PARAMETERS = {
    appId: "202201290625004",
    secret: "c73a8590641781f203660afca1d37ada",
    package_name: "com.zuoyou.novel",
    lang: "en",
};
export const REQUIRED_COOKIES = [
    "novelcool_webp_valid=true",
    "protocol_cookie_is_show=1",
    "protocol_cookie_is_allow=1",
    "novelcool_list_num=10",
];
export const SECTIONS = {
    FEATURED: "featured",
    LATEST: "latest",
    POPULAR: "popular",
    COMPLETED: "completed",
};
export const CATEGORY_PATHS = {
    RATING: "/category/index.html",
    LATEST: "/category/latest.html",
    COMPLETED: "/category/completed.html",
};
export const STATE_KEYS = {
    RELATIVE_DATE_ANCHOR: "novelcool_relative_date_anchor",
};
export const SORT_OPTIONS = [
    { id: "latest", label: "Latest" },
    { id: "popular", label: "Popular" },
    { id: "newest", label: "Newest" },
    { id: "rating", label: "Rating" },
];
export const TYPE_TITLES = new Set([
    "comic",
    "comics",
    "manga",
    "manhua",
    "manhwa",
    "novel",
    "web comic",
    "web novel",
    "webtoon",
    "webtoons",
]);
